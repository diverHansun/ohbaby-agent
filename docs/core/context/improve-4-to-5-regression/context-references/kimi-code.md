# Kimi Code context / compaction / replay / scope 调研报告

根目录：`/Users/hansunwork26/workspace/projects/code-cli/kimi-code`。本报告聚焦 `packages/agent-core-v2`；路径和行号以 `03-reference-projects.md` 记录的调研基线为准。

## A. Replayable Context 与 durable truth

- `src/agent/contextMemory/contextOps.ts` 把 append、clear、undo 和 `context.apply_compaction` 折叠为 context state；compaction summary 是 durable record 的一部分，恢复不重新生成摘要。
- `src/agent/contextMemory/contextMemoryService.ts` 负责把 compaction result 写成 durable context operation；live fold 与 replay 共享同一操作语义。
- `src/agent/fullCompaction/fullCompactionService.ts:445-448` 的 `normalizeAfterReplay()` 只把 stranded running phase 归一到可继续状态，不重启 summary LLM。
- `test/harness/agent.ts:1829-1863,2338` 的 `expectResumeMatches()` 先排空 wire，再用 `failOnResumeGenerate` 创建 resumed agent；恢复期间任何 generate 都直接失败，随后比较 live/resumed state snapshot。

这给 OhBaby 的直接启发不是改成 wire/event sourcing，而是：销毁 manager/store 后的 model view 必须与 live view 等价；resume 必须零 LLM、零历史 observable event。

## B. Full Compaction、summary overflow 与提交复核

- `src/agent/fullCompaction/fullCompactionService.ts:639-703` 生成 summary 时把 overflow shrink 与普通错误分开处理。发生 context overflow 后，`dropOldestMessageAndLeadingToolResults()` 从最旧端删除消息并清理由此形成的前导 tool result；缩小次数有 `MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS` 上限。
- 同文件 `historySafeToCompact()`（约 `:830-837`）要求当前 history 的原始前缀与生成候选时一致，新增内容只能是允许的真实 user input；否则取消 stale compaction，而不是把旧候选强行提交到新 history。
- `observeContextOverflow()` 以本次请求 token 的 85% 记入按 modelAlias 隔离的 observed maximum，`effectiveMax` 取声明值与观察值较小者。这是额外的 adaptive-window 产品策略，和 summary shrink 不是同一能力。
- compaction begin/complete/cancel 进入 replayable phase；apply 已持久化就保留结果，孤立 running phase 在恢复时归一化，摘要请求不会重新发起。

OhBaby 采用前两项作为 D8/D9 的机制参考；observed maximum 只作为 P2 已知限制记录，不在 improve-4～5 联合回归中新增持久化/衰减策略。

## C. Tool exchange repair 与确定性投影

- loop fold 会把在 durable state 中未完成的 tool exchange 表达为 interrupted/error，禁止假定副作用成功。
- request projector 还会在发送前修复 trailing call、乱序 result、orphan/duplicate result；真实 result 优先覆盖 synthetic projection。
- fold repair 与 request projection repair 的文案/归属不同，但都由已有 durable call identity 和状态推导；replay 不应因当前时间或随机数生成不同模型输入。
- 相关测试覆盖 fold parity、真实 result 覆盖 synthetic、compaction 落在未闭合 step 中间和 replay 静默性。

OhBaby 当前 serializer 尚没有等价的完整 repair 层，因此这不是“已有能力”的描述，而是 LIF-04/PFX-12 的目标不变量：repair 必须 deterministic，且不能把 unknown 误报为 success。

## D. Scope 隔离机制

**按 scope 隔离的状态**（每个 agent scope 各自一份实例，`registerScopedService(LifecycleScope.Agent, ..., ScopeActivation.OnScopeCreated)`）：
- `WireService`（独立 `wire.jsonl`，`wireService.ts:162-168`）
- `EventDispatcherService`（独立 fold/patch/checkpoint 历史，`eventDispatcherService.ts:405-410`）
- `AgentStateService`（`agentStateService.ts:78-84`）
- `AgentContextMemoryService`（`contextMemoryService.ts:164-170`）
- `AgentFullCompactionService`（`fullCompactionService.ts:904-910`）
- TokenCounting / Profile / Loop / Todo / Task / Blob（媒体 blob 库按 agent 隔离，`agentBlobServiceImpl.ts` 注册于 Agent scope）——即：**上下文、journal、压缩状态机、token 账本全部按 agent 隔离**，session 级只有 metadata / todo 目录 / subagent 服务等。

**子代理如何创建/使用 scope**：
- `AgentLifecycleService.create()`（`agentLifecycleService.ts:107-122`）：agentId 取 `agent-N` 递增（`nextAvailableAgentId` `:124-136`，同时查内存 handles 与持久化 metadata 防冲突）；`doCreate`（`:138-180`）以 `createScopedChildHandle(LifecycleScope.Agent, agentId, {seeds: [IAgentScopeContext, telemetry.withContext({agent_id}), runtimeBindingSeed]})` 建子 DI 容器 → `wire.seal()` → `sessionMetadata.registerAgent(agentId, {homedir, type: 'main'|'sub', parentAgentId, forkedFrom, labels})`（`:160-166`，注意 **parentAgentId 对所有非 main 代理固定记 'main'**，真实调用者放在 `labels`，见 `subagentLabels(callerAgentId)`，`spawnTool.ts:282`）→ `restore()` 重放该子代理自己的 journal。
- 工具侧：`SubagentTool`/`TowerSpawnTool`/`AgentSwarmTool` 构造时注入 `IAgentScopeContext`，用 `scopeContext.agentId` 作为 callerAgentId（`spawnTool.ts:62-72`、`agentSwarmTool.ts:83-90`）——即 scope 的**读侧**用于区分"我在替哪个代理发言"。
- 子代理运行：`SessionSubagentService.run`（`subagentService.ts:45-57`）→ `runAgentTurn`（`runAgentTurn.ts:30-54`）向子代理 prompt 队列注入 origin 为 `{kind:'system_trigger', name:'subagent'}` 的用户消息；tower worker 是 detached 后台任务（`spawnTool.ts:173-192`，注册进 TaskService + 超时 `DEFAULT_SUBAGENT_TIMEOUT_MS`）。

**父子上下文传递与回收**：
- 父→子：**仅 prompt 文本**（tower 用代码组装的 briefing，`spawnTool.ts:319-398`），无上下文继承。
- 子→父：**仅 summary**——`distillSummary`（`runAgentTurn.ts:111-140`）取子代理 context 最后一条 assistant 文本（不达标时按 `summaryPolicy` 用 continuationPrompt 续问）；`mirrorAgentRun`（`mirrorAgentRun.ts:129-186`）在**父代理的 dispatcher** 上派发 `SubagentStarted/Completed/Failed`（payload 含 resultSummary、usage、contextTokens）。注意这些事件只有 `observable = true` 非 durable（`mirrorAgentRun.ts:32-70`），不进父 journal；持久层的父子关系在 sessionMetadata 的 agents 注册表 + 各子代理自己的 journal。
- Fork 是唯一全量传递：`lifecycle.fork()`（`agentLifecycleService.ts:198-236`）把源代理 `contextMemory.get()` 全部 `append` 进子代理 + 复制 profile 绑定快照。
- 回收：`lifecycle.remove(agentId)`（`:261-281`）——stop 所有任务 → cancel 所有 pending turn → **abort 进行中的 compaction** → 等 `loop.settled() + compactionSettled + prompt.drain` → `handle.dispose()`。session 关闭时 drain 所有 agents 并删 session 目录（`sessionLifecycleService.ts:200-204`）。

---

## E. Token 计量 / 压缩阈值决策

**计量基础**：
- `tokenCountingKey`（`tokenCountingOps.ts:57-104`）：replayable state，由 durable 事件 `token_counting.measured / truncated / rebased / turn_recorded` 折叠成 anchors 账本（measured 锚优先、truncate 收缩、rebase 重置），策略为 `measured+estimated`（真实 usage 锚点 + 估算外推）。
- 压缩视角的当前 token = `tokenCounting.get().size`（含 pending 未发送消息，`fullCompactionService.ts:795-797`）；请求口径 = `requestSize({systemPrompt, tools(非deferred), messages})`（`:276-282`）。

**阈值决策**（`fullCompaction/strategy.ts`）：
- `DEFAULT_COMPACTION_CONFIG`（`:18-28`）：`triggerRatio 0.85`、`blockRatio 0.85`、`reservedContextSize 50_000`、`maxCompactionPerTurn Infinity`、`maxOverflowCompactionAttempts 3`、`maxRecentMessages 4`、`maxRecentSizeRatio 0.2`、`minOverflowReductionRatio 0.05`。
- `RuntimeCompactionStrategy.config`（`:91-101`）：`triggerRatio = model.compactionTriggerRatio ?? 0.85`，`blockRatio = max(triggerRatio, 0.85)`，`reservedContextSize = model.reservedContextSize ?? 50000`；窗口 = `max_input_tokens ?? max_context_tokens`。
- `shouldCompact / shouldBlock`（`:116-135`）：`used >= max*ratio` **或** 保留量启发式 `used + reserved >= max`（reserved < max 时）——即未到 85% 也可能因剩余空间不足 50k 提前压缩。`checkAfterStep` 仅当 trigger ≠ block 时为真（`:62-64`）。

**触发时机**（`fullCompactionService.ts`）：
1. **步前主动**：loop `onWillBeginStep` 钩子（`:176-181`）→ `beforeStep`（`:486-492`）→ `checkAutoCompaction`（`:501-511`）：已在压缩中则跳过；**防抖**：`tokenCountWithPending() <= lastCompactedTokenCount` 则不触发（`:504-507`）；过 `shouldCompact` 才 `beginAutoCompaction`（每 turn 上限，超限抛 `CONTEXT_OVERFLOW`）。
2. **步后主动**：`onDidFinishStep` → `afterStep`（`:494-499`），仅当 `checkAfterStep`（trigger≠block）。
3. **步前阻塞**：`shouldBlock` 命中时 `block(signal, turnId)`（`:527-539`）等压缩完成并派发 `compaction.blocked`。
4. **反应式恢复**：loop 错误处理器 `recoverFromContextOverflow`（`:188-194, 456-477`）：命中 `CONTEXT_OVERFLOW` 编码错误 / `APIContextOverflowError` / **413 且估算请求 ≥ effectiveMax × 0.5**（`OVERFLOW_STATUS_RECOVERY_RATIO`，`:295-308`）→ 触发压缩并重试失败的 driver。
5. **观察窗口记忆**：`observeContextOverflow`（`:310-321`）把 `floor(tokens × 0.85)` 记入 `observedMaxContextTokensByModel`（按 modelAlias），`effectiveMax = min(声明值, 观察值)`（`:248-257`）——供应商真实窗口比声明小时自动收紧后续阈值；连续 overflow 压缩超 3 次抛错（`:467-477`）。
6. 手动压缩走 RPC `begin({source:'manual'})`：要求 loop idle + quiescence 租约（`:323-337`）。

---

## F. 测试策略

**1. Replay 等价测试（核心武器）**：`test/harness/agent.ts:1829-1863` 的 `expectResumeMatches()` —— 排空 wire 持久化 → 用 **`failOnResumeGenerate`**（resume 期间任何 LLM 调用即失败）从 wire 记录重建一个新 agent → 增量追平新落盘记录 → 断言 `resumeStateSnapshot(resumed) === resumeStateSnapshot(live)`（快照含 config、context 历史、**所有 replayable+undoable state**、permission、usage，`:2342-2360`）。**34 个测试文件**使用该 harness；仅 `fullCompaction.test.ts` 内就调用 **41 次**——每个压缩故障场景都附带"崩溃重放后状态逐字段等价"断言。这是场景内嵌的确定性等价测试（未见 fast-check 式随机 property 测试框架）。

**2. Fold 等价测试**：
- `loopEventFold.test.ts`（"loop-event fold parity"）：`foldAll(事件流) ≡ appendAll(消息流)` 形状等价（`:44-87`）；interrupted/error 的 step.end 不 settle（`:219-240`）；下一次 step.begin 补 synthetic（`isError: true`）并密封半成品 assistant（`:164-208`）。
- `contextTranscript.test.ts` 的 "live fold parity"（`:298` 起）：UI transcript reducer 与 live 折叠视图逐消息一致；"compaction 落在 fold 中段时结算未闭合 step / 关闭 pending tool 交换"（`:396-431`）；undo/clear 边界行为。

**3. Compaction 状态机测试**：
- `compactionOps.test.ts`：begin/complete/cancel 驱动 phase + 落盘扁平 record；no-op fold 保持引用相等；**replay 静默重建（无 observable 泄漏）**；**孤立 `full_compaction.begin` 重放后 phase 停留 'running'**（即崩溃现场，`:144-152`）；legacy complete payload 兼容。
- `fullCompaction.test.ts`（3442 行、约 90 用例）覆盖的故障场景：溢出收缩（413/overflow/空摘要/纯 thinking，各带重试上限与 fail-fast on filtered）、PreCompact hook 中取消、压缩中 append 消息（前缀不变→保留 `:1382`；前缀变化→取消 `:1532`）、dispose 中止压缩（`:1198`）、压缩 prompt 内合成未配对 tool result（`:1331`）、压缩期间 prompt defer 与失败后重放（`:3227-3327`）、压缩后 goal reminder 重注入（`:3328`）、观察窗口记忆（`:2268-2373`）、保留阈值/比例触发（`:2023-2126`）等。

**4. Wire/journal 故障注入**：`eventDispatcher.test.ts`：fold 抛错 → 全有或全无（`:202-211`）、级联 >100 抛 `CycleError`（`:262-283`）、patch-history undo、checkpoint 协议、**未知/畸形 record 跳过并上报**（`:357-385`）、restore 期间迟到 contribute 回滚（`:429-440`）。`wire/resume.test.ts`：崩溃点重放不重启 turn/compaction/tool（`:169`）、孤儿 tool result 丢弃（`:634`）、undo 后 resume（`:824`）、分数 undo 记录跳过不破坏 checkpoint（`:918`）、wire 迁移中重放（`:429`）。`AppendLogStore` 容忍尾行截断（`appendLogStore.ts:60-83`）。

**5. 投影修复测试**：`projector-tool-exchanges.test.ts`：trailing 未应答调用合成、多调用按序合成、乱序 result 拉回、**真实 result 覆盖 synthetic**（`:372`）、孤儿/重复丢弃、anomaly 上报 + `context_projection_repaired` telemetry（`:531`）。

**6. 清单/兼容测试**：`wireManifest.test.ts` / `stateManifest.test.ts` 保证 `docs/wire-manifest.d.ts`、`docs/state-manifest.d.ts` 与代码同步（事件↔state↔owner 的可审计映射）。

---

## 对 ohbaby-agent 回归方案的对标提示（kimi-code 有而方案易漏的机制）

1. **压缩防抖**：`lastCompactedTokenCount` 下限（`fullCompactionService.ts:501-507`）——压缩后 token 不超过上次压缩后水平就不再触发。
2. **观察窗口记忆**：`observedMaxContextTokensByModel`（×0.85 安全系数）让 413 之后的阈值自适应收紧（`:310-321`）。
3. **压缩并发守卫**：`historySafeToCompact` 前缀一致性检查——压缩期间追加了非用户消息即整体取消而非合并（`:830-837`）。
4. **崩溃语义 = 数据前滚 + 状态机回滚**：apply_compaction 已落盘则保留压缩结果，stranded 'running' phase 由 `normalizeAfterReplay` cancel 归位；摘要请求**永不重启**（`:445-448`）。
5. **双层 synthetic tool repair 且文案不同**：fold 层（持久状态内、`isError: true`、'interrupted before its result was recorded'）vs 投影层（发送前、无 isError、'not available in the current context'），且投影层允许真实 result 覆盖 synthetic。
6. **undo 与压缩的边界协议**：compaction/clear 清空 undo checkpoint；undo 停在 compaction_summary 边界（`contextOps.ts:249-278`）。
7. **blob offload/rehydrate 往返**：journal 里媒体换 blobref、replay 后字节级还原，且 rehydrate 替换状态后 fold 仍能正确 settle 中断 step（`splice-replay.test.ts:479-521`）。
8. **replay 静默性**：重放不重发 observable 事件、不重写 journal、fold 内 emit 被吞——回归测试应断言"重放零副作用"。
9. **手动压缩的 quiescence 租约** 与 per-turn 压缩计数。
10. **父子传递的最小契约**：子代理只收 prompt、只回 summary（usage/contextTokens 附带）；fork 才全量复制；agent 删除时显式 abort 压缩并 drain。
11. **测试范式**：`expectResumeMatches` + `failOnResumeGenerate` 的"崩溃等价"断言值得直接移植为 ohbaby 的回归测试骨架。
