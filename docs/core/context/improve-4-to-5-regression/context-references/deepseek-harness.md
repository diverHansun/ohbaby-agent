调研完成。以下是完整报告。

---

# deepseek-harness 调研报告：context 管理 / compaction / 崩溃恢复 / 主子代理隔离

## 断言核实表

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| 1 | `docs/subsystems/compaction.md:15-19`：压缩先写 `compaction/start`，summary/replacement 落地后最后写 `compaction/end`；中途 crash 留下可检测 orphan lock | **属实** | `docs/subsystems/compaction.md:19` 原文："The lock brackets the **whole** operation… only then `compaction/end`. Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compaction/start` with no matching `compaction/end`)"；源码级证据 `packages/compaction/compaction/README.md:41-49`（5 步事务）+ `compaction-basic/src/region.ts:189-229` |
| 2 | `compaction.md:88`：压缩边界前后检查 tool-call/result pairing | **属实** | `compaction.md:88`："exports `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)` for the tool-call/result pairing checks before and after a seq"；配套 `compaction.md:86` "Region boundaries preserve tool-call/result pairing but not whole turns"；实现在 `compaction/src/index.ts`（导出），测试 `compaction/tests/tool-pairing.spec.ts` |
| 3 | `packages/core/session/tests/properties.spec.ts:96-157`：用 `fast-check` 验证 log replay、seq、immutability | **属实**（细节：引用行号略短） | `properties.spec.ts:11` `import fc from 'fast-check'`；96-119 replay/seq、121-129 幂等、131-154 噪声不变量；**frozen/immutability 断言实际在 156-170 行**（略超出 157），内容为 `Object.isFrozen(m)` 且 mutation 抛 `TypeError` |
| 4 | `crash-recovery.e2e.ts:46-59`：子进程到 failpoint 后 SIGKILL | **属实** | `crash-recovery.e2e.ts:46-47` 注释 "The SIGKILL-at-failpoint choreography stays custom: the child must die mid-write"；`:57` `child.kill('SIGKILL')`；`:58-59` 断言 `{ code: null, signal: 'SIGKILL' }`；failpoint 用 marker 文件**内容**（非存在性）判定就绪 |
| 5 | 同 suite `:84-108`：请求 dispatch 前事实持久化；tool side effect 后缺失结果恢复成 unknown | **属实** | `:83-94` 'persists the complete request before model dispatch'（断言事件序含 `request/header`、`request/context`，turn 以 `interrupted` 关闭）；`:96-110` 'persists tool intent before a side effect and repairs its missing result as unknown'（断言 `ToolOutcomeUnknownError` / `TOOL_OUTCOME_UNKNOWN`，文案含 "Do not retry blindly."） |

---

## A. Compaction 事务 / 两阶段提交

**markers 存在哪里**：不是独立锁文件，而是**三条 log-only session 事件**（`compaction/start` / `compaction/summary` / `compaction/end`），直接追加进 session 事件日志。`packages/compaction/compaction/README.md:59` 明言："The lock is the durable bracket, not a `WeakSet`, wrapper mutex, or client-side anchor."

**事务实现**（`packages/compaction/compaction-basic/src/region.ts:152-254`，`compactSurfaceRegion`）：
1. `:163-168` 先做只读校验（range 合法 + `assertCompactionInactive` 锁检查），随后 `:189` **同步**追加 `compaction/start`（在与校验相邻的同步段内，锁在任何 await 之前落盘）；
2. `:201-209` 异步 summarize（直接 `ctx.llm.stream()` 一次性调用）；
3. `:211` 稳定性重校验（automatic=whole-surface / manual=selected-span，`:386-424`）；
4. `:213` `commitCompactionBody`（`:427-478`）**不 yield** 地连写 `compaction/summary` + 带 `surfaceOp: {op:'replace', start, end}` 的替换 `user/message`（source 为 `compactCheckpointSource(compactionId)`）——这是唯一一次 surface 变更；
5. `:215` 追加 `compaction/end`。失败路径 `:218-228`：恰做一次 `compaction/end { error }` 关闭尝试；**若 close 本身写入失败，则故意留下 unmatched start 作为 busy 信号**（不 flush、不回滚）。

**重启后 orphan 检测（既非回滚也前滚，而是“封堵+过期判定”）**：
- `region.ts:516-550` `inspectCompactionEntryState` 从日志尾部倒扫，独立找三样：最新 unmatched `compaction/start`、最新 `session/end-seed`、open turn；
- `region.ts:286-298` `assertCompactionInactive`：unmatched start **晚于**最新 `session/end-seed` → 抛 `busy`（视为本进程存活的锁）；**早于**它 → "stale evidence from a prior lifecycle"，不阻塞；
- 关键机制：`session/end-seed` 由 Session 构造器在从持久化日志 seed 时作为首个 live 写入自动追加（`packages/core/session/src/index.ts:545-547`），这就是区分"上个进程 crash 留下的孤儿锁”与“本进程正在压缩”的分界线。设计理由见 `docs/subsystems/session.md:587-593`（"an unmatched `compaction/start` reads the same whether the writer crashed mid-compaction or is compacting right now"——end-seed 解决了这一不可区分性）；
- 恢复语义：surface 替换与 end 之间无 await（原子提交段），crash 只可能留下「无替换+孤儿 start」或「已替换+可能缺 end」，**没有回滚代码**——失败尝试留在日志中（`changed`/`summary` 失败 surface 不动但尝试仍落日志，`compaction/README.md:31`）；孤儿锁靠"busy 封堵一切入口直到更新 end-seed 出现"来收敛；
- 回放期校验：`packages/compaction/compaction/src/invariant.ts:76-92` `inheritedOrphanStartSeqs` 计算"被后续 end-seed 判死"的孤儿 start 集合；`:248-297` invariant companion 通过 `internal/dispatch` 做**pre-commit 暂存 + session/event 提交**两段式校验 start/summary/end/checkpoint 的 compactionId、sourceCommandId、owner-turn 一致性、禁止跨 turn 边界。

对应测试矩阵：`compaction-basic/tests/manual-compaction.spec.ts:420-433`（活孤儿→busy 不 summarize）、`:435-466`（end-seed 之前的过期孤儿被忽略，且独立于后续 repaired turn state）、`:568-579`（`compaction/end` 写失败→commit failure + 留一个孤儿）；`compaction/tests/invariant.spec.ts:65-130`（end-seed 在 replay 时清除继承的孤儿 trace）。

## B. Session 事件日志结构与 replay

**事件结构**：`SessionEvent` 信封 `{type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable?}`（`packages/core/session/src/index.ts:627-633`）。三类 surface 事件（`user/message`/`assistant/message`/`tool/result`）必须携带 `surfaceOp`（`append` 或 `{op:'replace',start,end}`），其余事件 log-only 不进 surface（`packages/core/session/src/surface.ts:15-68`）。

**seq 单调性**：靠**构造保证**而非运行时检查——`append` 赋 `seq: this.log.length`（`index.ts:629`，"seq = log.length contiguity contract"）；构造器 seed 校验强制 `snapshot.seq !== index` 即抛错（`:525-527`），且 seed 事件走与 live append **完全相同**的 surface 转换校验 `surfaceManager.validateNext`（`:516-537`），因此"replay == 增量 fold"。

**持久化**：`SessionStore` 只管内存；持久化插件订阅 `session/event`（fire-and-forget 缓冲）并在 `session/flush`（awaited parallel checkpoint，`index.ts:66-86, 1022-1039`）落盘。`PersistenceCoordinator`（`packages/session/session-persistence/src/coordinator.ts:1123-1129`）用 write-behind 队列（`writeBatchMaxDelayMs` 批量）缓冲，flush 是显式 durability barrier。

**JSONL 后端崩溃语义**（`packages/session/session-persistence-jsonl/src/index.ts`）：
- `appendLines`（`:651-689`）：write + `handle.sync()`(fsync)；**部分写/fsync 失败时 truncate 回原 size 再重抛**，保证重试无 seq gap（测试 `jsonl.spec.ts:641-674` 用 `vi.spyOn(FileHandle.prototype, 'sync')` 模拟第一次 fsync ENOSPC）；
- torn tail：`scanLog`/zstd 帧扫描给出 `committedBytes < byteLength` 的 `tornMarker{truncateTo}`，zstd 还能从残帧恢复完整事件（`:310-419`）；
- 修复两段 fsync：truncate torn tail → 恢复完整事件 → 追加合成 closer（`:436-443`）；**committed 前缀永不重写**（`jsonl.spec.ts:622-639` 字节级断言）。

**重载修复（前滚式补全）**：`coordinator.ts:892-931` `prepareCore` 调 `interruptedTurnClosers`（`packages/core/session/src/repair.ts:27-133`）——扫描 turn/step/待配对 tool-call 状态，为开放的尾 turn 合成：①未匹配 call 的合成 error tool/result（有 `tool/call` 记录→`TOOL_OUTCOME_UNKNOWN`+防盲目重试文案；无→`TOOL_NOT_STARTED` 可重试）；②`step/end`；③`turn/end {reason:'interrupted'}`。seq 续接日志、时间戳复用最后真实事件（确定性，不发明未来时间，`repair.ts:82-86`）。

**派生历史**：`deriveMessages()`（`index.ts:726-747`）对有序 surface 节点逐个过 `deriveEventMessage`（`surface.ts:83-114`），带 per-node 增量缓存与 replaceGeneration 失效；`foldSurface`/`SurfaceFoldResult`（`surface.ts:116-134`）提供纯函数式全量重放，外部重建器复用同一投影规则——这就是"从日志+代码可重建任意一次请求"的根基。

## C. 主/子代理上下文隔离

**核心隔离 = 一 Agent 一 Session**：agent 工厂在同一身份下创建 session+agent（`packages/core/agent/src/index.ts:76-106`）；上下文（事件日志、surface、token 计量、compaction 锁）天然按 Session 隔离（TokenMeter 按 Session 弱引用表维护 ReplayState，`token-meter/src/index.ts:79`）。

**Subagent 是可选能力 seam**（`docs/subsystems/subagent.md`），多 provider 并存：
- `subagent-spawn-in-process`：全新子 Agent——"its own session, own system prompt, **zero parent context**"（该包 `src/index.ts` 头注释）；
- `subagent-fork-in-process`：子 session 以父方**已完成 turn 的前缀**为 seed（`completedTurnPrefix`），`session/end-seed` 标记血缘边界；
- out-of-process provider（acp/codex/claude-code/dsh-sdk）：进程级隔离。

**子 session 头部血缘**（`subagent/src/child-agent.ts:102-120` `childSessionMeta`）：`parentSession`、`origin:'subagent'`、`delegationDepth`（持久化的递归预算）、`seedLength`、`agentPreset`——冷启动可从子日志重建其组合。深度控制 `:48-57`：父的持久化 delegationDepth 是单调下限（resume 过的父不能当顶层再委托），可加 `maxDepth` 硬上限。

**Scope 概念**（`packages/core/scope`，`docs/subsystems/scope.md`）：`ScopeKey` 是不透明对象身份（生产中即 **Agent 对象本身**）；双层语义——注册可见性沿链**向下**继承（子 scope 看到祖先的注册层），事件准入沿链**向上**扩展（标记祖先的监听器收到派发给后代 key 的事件）（`scope/src/index.ts:30-39`）。session 四事件（`session/created|disposed|event|flush`）全部以 `this: Scoped<Session>` carrier 派发（`session/src/index.ts:42-86, 915`），即 **agent-scoped 监听器只收到经自己 context 进入的 session 的事件**——这是事件总线层面的上下文隔离。

**子代理组合窗口**（`child-agent.ts:163-175` `applyChildComposition`）：join 父 preset → 注入固定 delegation 声明（"权限 scope 在启动时固定、不可从内部扩大"）→ 子专属 persona（shadow 部署 persona）→ `tools.restrict(toolFilter)`——全部由**子 scope 持有，父与兄弟不可见**。策略钉死：`:199-204` approval 钉 'never'、捕获 sandbox override，`:215-225` 以 `source:'delegation'` 事件写进**子自己的日志**，使子策略可从其日志独立重建。嵌套 tool dispatch 复用外层 durable call（`session-checkpoint-policy/src/index.ts:71`）。

## D. Token 计量与压缩阈值决策

**TokenMeter**（`packages/llm/token-meter/src/index.ts:74-147`）：单例 `ctx.tokenMeter`，replay-aware——每 session 维护增量 fold（consumedEvents/header/带逐节点 token 的 surface/usage anchor）；`measure()` 返回 `{logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes}`。Provider usage 仅在最近成功调用的 canonical envelope 与 `requestHeader()` 匹配且不低于启发式锚点时复用，否则按字符数+结构开销启发式重估（`estimate.ts`）。

**阈值决策**（`compaction-basic/src/index.ts:258-332` + `config.ts`）：
- 触发点1：`agent/pre-step` 串行监听（`:147-165`）——每步请求派生前测 pressure；
- 触发点2：`agent/request-error` 且 `code === CONTEXT_WINDOW_EXCEEDED`（`:179-223`）——overflow 恢复**绕过阈值**，先 prune 再做一次极大平衡头压缩，仅当 `surface.replaceGeneration` 前进才授权 retry；
- 阈值换算（`config.ts:133-167` `resolveCompactSpec`）：`thresholdTokens = floor(contextWindow × thresholdRatio)`（默认 0.8），`retainTokens = floor(contextWindow × retainRatio)`（默认 0.16）或绝对值；容量来自 `ctx.llm.resolveModelInfo()`；支持按精确 provider/model 的 `modelPolicies` 覆盖；
- 范围选择（`region.ts:98-134`）：保留 priced 尾部 ≥ retainTokens，切点向头侧回退直到 `toolPairingBalancedBefore` 通过；
- 收敛约束：framed summary token 必须 < shadowedTokenCount（`region.ts:373-378`），最多 `compactionRetries`(默认1) 次循环，仍超阈值则抛错（`index.ts:314-331`）。

## E. Failpoint 注入基础设施

**没有通用的"第 N 次写失败"框架**，是两种手工模式：

1. **子进程 SIGKILL-at-failpoint 编排**（`session-checkpoint-policy/tests/crash-recovery.e2e.ts:39-65` + `fixtures/crash-child.ts`）：子进程在精确故障点**写 marker 文件内容**（mock LLM adapter 的 `stream()` 内写 `request-dispatched` 后永久挂起，`:24-25`；tool `execute()` 内写 `tool-side-effect` 后挂起，`:50-51`）；父进程用 `vi.waitFor` 轮询 marker **内容**（非存在性——文件预创建为空，`:43-44`，保证"先打开后写"窗口确定性）然后 SIGKILL。`:46-47` 注释明确说明该编排必须定制，因为子进程必须死于 mid-write，任何 timeout/优雅终止都不能先到。
2. **闭包计数器 + `vi.spyOn` 原型方法**实现"第 N 次失败"：如 `jsonl.spec.ts:655-658` spy `FileHandle.prototype.sync`，`let failed = false; if (!failed) { failed = true; throw }` 模拟恰好第一次 fsync ENOSPC（且允许后续恢复 truncate 的 fsync）；`manual-compaction.spec.ts:573-576` spy `session.append` 精确拒绝 `compaction/end` 一种事件。

## F. 值得借鉴的测试策略

1. **Property-based 不变量清单**（`properties.spec.ts`，可直接对标 ohbaby 的 PBT 覆盖面）：
   - `deriveMessages` 确定性（同日志→相同派生）；
   - `seq` 严格单调、零基连续、`session.seq === events.length`；
   - **replay-from-seed 逐字节复现派生**，且每次显式 replay 恰好多一条 log-only 边界；
   - **重放幂等**：以已含 end-seed 的日志再 replay 不再增长（lazy resume 不随打开次数膨胀）；
   - 非消息事件在**任意保序交错**下（`fc.infiniteStream(fc.boolean())` 驱动随机归并）不影响派生历史；
   - 派生消息深冻结：mutation 抛 `TypeError`、log 前后 `structuredClone` 相等。
2. **分层 crash matrix**（ohbaby 方案最可能遗漏的部分）：
   - 进程级：子进程双 failpoint（request-dispatch / tool side-effect）+ SIGKILL + 重载断言精确事件序；
   - 持久化级：直接向日志文件追加 torn 尾巴（截断行、残 JSON）模拟 crash（`jsonl.spec.ts:585-620`）；committed 前缀字节不变断言（`:622-639`）；fsync 失败→truncate 回滚→重试无 seq gap（`:641-674`）；回滚失败聚合成 AggregateError（`:676+`）；
   - **后端无关契约**：`session-persistence/tests/contract.ts` 被 jsonl/sqlite 两后端共享复用（interrupted turn closer、TOOL_NOT_STARTED 可重试合成结果等，`:118-219`）；
   - 日志级 compaction 孤儿矩阵：活孤儿 busy / end-seed 前过期孤儿忽略 / 与后续 repaired turn 状态解耦 / close 写失败留一孤儿。
3. **invariant companion 框架**：每包一个 `./invariant` 插件，注册到 `ctx.invariants`（子 fiber 隔离、包名归属报错），compaction 的伴生检查在 `internal/dispatch` 做 **pre-commit 暂存**、在 `session/event` 提交，且构造器 seed replay 也被同一检查覆盖（`compaction/src/invariant.ts:248-297`）——"运行时不变量"与"重放不变量"共用一套代码。
4. **语义 checkpoint（write-ahead fact）测试**（`session-checkpoint-policy`）：model dispatch 前 flush 全请求前缀（fail-closed，checkpoint 拒绝则不派发 adapter）、tool body 前 flush、pre-step flush；这些边界各有 spec + e2e 双层测试（`session-checkpoint-policy.spec.ts:63-238`）。
5. 其他策略（`docs/testing.md`）：src 每文件 100% 覆盖门禁；"verify the world, not the self-report"（外部重读文件/重跑命令，不信 agent 自述）；只 mock 昂贵/非确定边界（LLM/网络/时钟）；带 key 真实 API e2e 无 key 自跳过；快照层固定 transcript + **re-persisted log** 双比对；修复用时间戳复用最后真实事件时间以保证确定性。

**给 ohbaby 对标的关键提醒**：deepseek-harness 的孤儿锁检测依赖 `session/end-seed` 这一"进程生命周期边界"事件——没有它，unmatched start 无法区分"crash 残留"与"正在压缩"；同时 surface 替换提交段（summary+replace+end）是无 await 原子段，crash 只会落在段外。这两点是回归测试必须覆盖、而仅测"start 无 end 即孤儿"会漏掉的机制。