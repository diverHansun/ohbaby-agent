调研完成。以下为完整报告。

---

# 断言核实表

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| 1 | `docs/compaction.md:43-45`：compaction append entry 保存 `summary + firstKeptEntryId`，随后重建 model context | **属实** | 文档 44-45 行原文一致；代码锚点：`agent-session.ts:1952-1955`（`appendCompaction` → `buildSessionContext()` → `agent.state.messages = ...`），`session-manager.ts:1097-1119` |
| 2 | 同文档 `:79`：重复压缩从上一 kept boundary 继续，重新计算真实 pre-compaction context | **属实** | `compaction.ts:744-759`：`boundaryStart = firstKeptEntryIndex ?? prevCompactionIndex + 1`（含 fallback 语义）；`compaction.ts:762`：`tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens`（从重建后 context 重算） |
| 3 | `packages/agent/src/harness/session/context.ts:45-49`：`defaultContextEntryTransform()` 是简单纯投影，从最新 compaction 构建 context entries | **属实** | `context.ts:45-57`：倒序找最新 compaction entry，返回 `[compaction, ...pathEntries.slice(compactionIndex + 1)]`，无任何写操作。注意：该 harness 中 `CompactionEntry` 用 `retainedTail`（保留消息内联存储，`types.ts:44-51`），而非 `firstKeptEntryId` |
| 4 | `7150-*.test.ts:14`：manual compaction 中拒绝新 prompt | **属实** | 测试第 14 行 `"rejects an RPC prompt while manual compaction is in progress"`；锁在 `agent-session.ts:1144-1148`（`prompt()` 内 throw，非排队）；RPC 层 `rpc-mode.ts:394-415` 把错误回传客户端 |
| 5 | `8328-*.test.ts:50,66`：Provider 无 usage 时用 message estimate，低于阈值不误压缩 | **属实** | 第 50 行 `"uses the message estimate when no assistant has reported usage"`、第 66 行 `"does not compact when the zero-usage message estimate is below the threshold"`；对应 `agent-session.ts:2129-2152` + `compaction.ts:202-230` |
| 6 | `6647-*.test.ts:82-189`：transient retry、不可重试错误、最大重试、abort backoff 均有命名回归 | **属实** | 82 行 transient `terminated` 重试成功（1+2 次调用）、114 行 `insufficient_quota` 不重试、131 行 retry 禁用不重试、148 行 maxRetries 耗尽报错、169 行 `abortCompaction()` 中断 in-flight backoff（`compaction_end.aborted === true`） |

补充说明（断言 4 的细节）：**拒绝发生在 AgentSession.prompt() 层（硬 throw），不是排队**；但 TUI 交互层选择本地排队（`interactive-mode.ts:3183-3193` → `queueCompactionMessage` 4441-4447，compaction_end 后 flush）。RPC 与 SDK 调用方收到的是异常。

---

# A. Append-only Compaction Entry 完整机制

**架构分层**：pi 有两代机制。生产路径在 `packages/coding-agent`（`AgentSession` + `SessionManager`，JSONL append-only 树）；`packages/agent/src/harness` 是下一代 harness（lanes + durable operation records），其 compaction 纯函数已完整但 `AgentHarness` 编排层仍是 scaffold（`agent-harness.ts:355-357` 全部返回 `HarnessNotImplemented`），目前主要供 evals 与 conformance 测试使用。

**Entry 定义与存储**（生产路径）：
- `session-manager.ts:69-80`：`CompactionEntry { type:"compaction", id, parentId, timestamp, summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook? }`
- 持久化为 JSONL：`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`，一行一个 entry（`_persist` `session-manager.ts:1015-1042` 用 `appendFileSync`）。**永不改写旧行**（只有 v1→v3 migration 触发整文件重写，且 migration 会把旧格式 `firstKeptEntryIndex` 转为 `firstKeptEntryId`，`session-manager.ts:246-255`）
- `appendCompaction()`（`session-manager.ts:1096-1119`）：以当前 leaf 为 parent 追加 compaction entry，推进 leaf 指针 → compaction entry 成为树上最新节点，**旧消息 entry 原样留在文件里**

**写入时序**（manual 路径 `agent-session.ts:1867-2015`）：
1. `await this.abort()`（1868，先中止当前 agent 操作）→ 创建 `_compactionAbortController`（1869）→ emit `compaction_start`
2. `prepareCompaction(pathEntries, settings)` → `session_before_compact` 扩展钩子（可 cancel / 提供自定义 summary）→ `compact()` 生成 summary
3. `appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage)`（1952）→ `buildSessionContext()` 重建并赋给 `agent.state.messages`（1954-1955）→ 计算 `estimatedTokensAfter`
4. **先清锁再通知**：1982 行 `_compactionAbortController = undefined` 在 emit `compaction_end` 之前执行，使 compaction_end 监听者可立即提交排队的 prompt

**重复压缩链式衔接（firstKeptEntryId 语义）**——`compaction.ts:736-815` `prepareCompaction()`：
```
prevCompactionIndex = 路径上最新 compaction（倒序找，744-750）
previousSummary = prevCompaction.summary                    // 752-756
boundaryStart = pathEntries.findIndex(id === prevCompaction.firstKeptEntryId)
              ?? prevCompactionIndex + 1                    // 757-758 fallback
tokensBefore  = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens  // 762
cutPoint      = findCutPoint(pathEntries, boundaryStart, end, keepRecentTokens)          // 764
messagesToSummarize = [boundaryStart, historyEnd)           // 776-780
```
即：下一次压缩的**待摘要区间从上一轮 kept boundary（firstKeptEntryId 指向的原始 entry）开始**，而非从 compaction entry 开始——上轮幸存消息会再次参与摘要；若 kept entry 在当前路径找不到（如分支切换），fallback 到 compaction entry 的下一个 entry。`previousSummary` 作为迭代上下文传入 `UPDATE_SUMMARIZATION_PROMPT`（合并式更新，500-539）。测试 `test/compaction.test.ts:412-433` 固化"多次 compaction 只有最新生效"。

**Agent harness 变体**（`packages/agent/src/harness/compaction/compaction.ts:616-687`）：`CompactionEntry.retainedTail` 直接内联保留消息；重复压缩时把 `prevCompaction.retainedTail` 重建为 virtual entries 拼在新区间前（637-645），语义等价于 firstKeptEntryId boundary。

# B. 纯投影 buildSessionContext / defaultContextEntryTransform

**生产路径**（`session-manager.ts`）：
- `buildSessionPath()`（334-360）：从 leaf 沿 `parentId` 走到 root，得到当前路径（树结构 + leaf 指针 = 分支选择）
- `buildContextEntries()`（418-454）：沿路径找**最新** compaction → 可见 entry 列表 = `[compaction] + path[firstKeptEntryId..compactionIdx) + path[compactionIdx+1..]`（441-453）
- `sessionEntryToContextMessages()`（383-408）：compaction entry → `createCompactionSummaryMessage(summary, tokensBefore, timestamp)`（`messages.ts:109-120`，运行时渲染为 `COMPACTION_SUMMARY_PREFIX` 包裹的 compactionSummary 角色消息，`messages.ts:11-17`）
- `buildSessionContext()`（461-470）：`messages = contextEntries.flatMap(sessionEntryToContextMessages)`

**为什么不需要修改/删除旧 entry**：可见性是 append-only 树的**纯投影**。SessionManager 注释明言"append-only: use appendXXX() to add entries, branch() to change the leaf pointer. Entries cannot be modified or deleted"（`session-manager.ts:1298-1300`）。好处：① 历史完整可审计、可导出 HTML/JSONL；② `/tree` 可导航回压缩前分支（旧 entry 仍在）；③ compaction 只是树上又一个 entry，崩溃恢复 = 重放 JSONL 重建索引。压缩后 `agent.state.messages` 被**整体替换**为投影结果（`agent-session.ts:1955/2280`），agent 内存状态与投影无增量同步问题。

**Agent harness 路径**（`context.ts`，即断言 3）：
- `defaultContextEntryTransform()`（45-57）：`compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)]`
- `buildContextEntries()`（59-63）：在默认投影之上叠加可配置 `entryTransforms`；`entryProjectors` 支持自定义 entry 注入消息（20-23）
- `sessionEntryToContextMessages()`（65-88）：compaction → `[summaryMessage, ...entry.retainedTail]`；还处理 `deferred` assistant 消息过滤（72）
- `deriveSessionContextState()`（25-43）：同一遍历派生 thinkingLevel/model/activeToolNames

# C. Manual Compaction 期间拒绝新 Prompt

**锁在哪一层**：`AgentSession` 单字段锁 `_compactionAbortController`（`agent-session.ts:332` 声明；`compact()` 开始时赋值 1869；正常结束在 emit `compaction_end` 前清空 1982；`finally` 兜底清空 2013）。`isCompacting` getter（956-963）额外覆盖 auto compaction 与 branch summary 的两个 controller。

**拒绝而非排队**（核心层）：`prompt()` 在扩展命令处理后、streaming 队列分支**之前**硬检查（`agent-session.ts:1144-1148`）：
```ts
if (this._compactionAbortController !== undefined) {
    throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
}
```
注意：该检查只针对**手动** compaction 的 controller；auto compaction 期间 TUI 通过 `isCompacting` 排队，且 auto compaction 通常发生在 post-run 循环内。

**各入口的行为差异**：
- **RPC**（`rpc-mode.ts:394-415`）：`preflightResult(false)` → 不发 success，catch 后 `output(error(id, "prompt", e.message))` 回传错误。回归 7150 验证：错误信息含 "compaction is in progress"、消息未持久化、无 `agent_start`/`agent_settled` 事件
- **TUI**（`interactive-mode.ts:3183-3193`）：扩展命令立即执行，普通输入进 `compactionQueuedMessages` 本地队列（4441-4447），`compaction_end` 后 `flushCompactionQueue`（4459+，`willRetry` 时入 steer 队列跟随重试 turn，失败时回滚队列）
- **扩展监听者**：因锁在 `compaction_end` emit 前释放（1981-1982 注释），`compaction_end` listener 可直接提交 prompt（特征测试 `test/suite/agent-session-compaction.test.ts:159` "allows a queued prompt to start when manual compaction ends"）

# D. Tree/Branch 与 Subagent 机制

**核心：无内置 subagent，采用三套互补机制**

1. **Session 树 + /tree 导航（进程内分支）**：
   - 每个 entry 有 `id/parentId` 形成树；leaf 指针即当前位置（`session-manager.ts:143-166`）；`branch()`（1360-1365）只移动 leaf，不动历史；`getTree()`（1310-1348）供 TUI 树选择器
   - `navigateTree()`（`agent-session.ts:3033-3222`）：streaming 中拒绝（3037-3039）；`collectEntriesForBranchSummary`（`branch-summarization.ts:108+`，从旧 leaf 走到公共祖先收集 entries）；`session_before_tree` 钩子可 cancel（回归 3688 验证 cancel 后 `isCompacting=false` 且 leaf 不动）/提供自定义 summary；`branchWithSummary()`（`session-manager.ts:1381-1406`）在目标位置追加 `BranchSummaryEntry`（摘要注入新分支上下文，渲染为 `branchSummary` 消息）；最后重建 agent state（3205-3206）
   - `createBranchedSession`（1413+）：把某条路径 fork 成新 session 文件，header 记 `parentSession` 血缘

2. **Subagent = 示例扩展 + 子进程**（`examples/extensions/subagent/index.ts`，README:500 明言"No sub-agents... build your own with extensions"）：
   - **创建独立 session/context**：`registerTool("subagent")`（472-481），每次调用 spawn 独立 `pi --mode json -p --no-session` 子进程（300、344-350）——上下文隔离 = OS 进程 + 独立（内存）session，与父 session 零共享
   - **上下文传递**：仅任务字符串 `Task: ${task}`（341）+ agent 的 markdown 定义（frontmatter: name/description/tools/model + 正文即 system prompt，经临时文件 `--append-system-prompt` 注入，334-339）；model/thinking 默认继承派发会话（486-488），tools 可按 agent 收窄（307）
   - **结果回传**：解析子进程 stdout JSON 流（`message_end`/`tool_result_end`，353-388），最终输出作为 toolResult 文本返回父模型（parallel 模式每任务上限 50KB，README:116）；usage 聚合进 `details`；abort 通过 SIGTERM→SIGKILL 传播（410-420）；chain 模式用 `{previous}` 占位符串行传递（556）
   - **per-subagent 压缩**：无显式配置——子进程用默认设置（auto-compaction 默认开启）跑在自己的 in-memory session 上；父进程不可见、不可控。即"每 subagent 独立压缩"是进程隔离的自然结果，非专门机制

3. **下一代 lanes 设计**（`packages/agent` harness，未完成）：`docs/harness.md:98` "Lanes. Named cursors into the tree... Additional lanes support Slack threads, subagents, and other parallel work over shared history"。`Session.createLane/view(lane)`（`session.ts:115-132, 190-196`；`memory.ts:47-56`），每 lane 独占 leaf/model 配置/队列/至多一个 operation（`LaneBusy` 错误类型 `agent-harness.ts:28-33`）；compaction 是 durable operation（`types.ts:100-104` operation intent；129-148 `step_attempt` 持久化 `compactionReason` 供崩溃恢复）。**这是"共享树 + 多 lane 隔离上下文"的设计方向，ohbaby 若做 subagent 共享历史可对标**

# E. Token 计量与压缩阈值决策

- **阈值**：`shouldCompact()`（`compaction.ts:235-238`）：`contextTokens > contextWindow - reserveTokens`；默认 `enabled/reserveTokens=16384/keepRecentTokens=20000`（132-136）
- **usage 提取**：`calculateContextTokens()`（146-148）优先 `totalTokens`，退化 `input+output+cacheRead+cacheWrite`；`getAssistantUsage()`（154-167）跳过 aborted/error/全零 usage
- **usage 缺失时的 estimate**：`estimateContextTokens()`（202-230）= 最后一条有效 assistant usage + 其后消息的 `estimateTokens`（chars/4 保守启发式，266-306；图片按 4800 chars）；**完全无 usage 时纯消息尺寸估计**。`ContextUsageEstimate` 返回 `lastUsageIndex` 供 stale 判定
- **决策树** `_checkCompaction`（`agent-session.ts:2053-2157`）：
  - 跳过 disabled / aborted（pre-prompt 检查除外）
  - **换模型保护**（2062-2067）：overflow 消息来自其它模型时不触发
  - **stale pre-compaction 保护**（2069-2077）：assistant timestamp ≤ 最新 compaction timestamp → 跳过，防止压缩后首条 prompt 被旧 usage 误触发；threshold 分支的 usage-backed estimate 也有同款检查（2135-2148）
  - **overflow 三态**：`willRetry = stopReason !== "stop"`；完成响应 → 压缩不重试；失败响应 → 删末条 assistant、压缩、`agent.continue()` 重试一次（`_overflowRecoveryAttempted` 单次护栏 2093-2113）；二次仍失败 → 显式错误信息
  - **threshold**：direct usage 为 0 或 error 消息 → `estimateContextTokens` fallback（保证 529 类持续错误或畸形零 usage 响应仍能压缩且不重置记账，2125-2128 注释；回归 8328）
- **压缩后记账**：`getContextUsage()`（3302-3346）压缩后只信任 compaction 边界之后的 assistant usage，否则报 `tokens: null`（UI 显示未知）

# F. Summarization Retry/Abort/Backoff 状态机

- **统一收口**：`completeSummarization()`（`compaction.ts:565-586`）——所有 compaction/branch-summary 摘要调用经此：`cacheRetention:"none"` + 新 `sessionId: uuidv7()`（一次性请求不写 prompt cache）+ `toolChoice:"none"`，包 `retryAssistantCall`
- **状态机** `retryAssistantCall()`（`packages/ai/src/utils/retry.ts:163-212`）：
  - abort → 终态，永不重试（177-180）
  - 成功 → 立即返回（183-186）
  - 不可重试（`isRetryableAssistantError` false）或预算耗尽（`attempt >= maxAttempts`）→ 返回最终错误（189-192）
  - 否则 `attempt++`，`delay = baseDelayMs * 2^(attempt-1)` 指数退避（196）；`onRetryScheduled` → sleep → **sleep 中 abort 归一化为 aborted AssistantMessage**（201-209，调用方无需区分取消时机）→ `onRetryAttemptStart` → 循环
- **错误分类**（`retry.ts:7-90`）：不可重试 = quota/billing 类（`insufficient_quota`、`out of budget`、`quota exceeded`、`billing`、订阅限额）；可重试 = overloaded/429/5xx、网络传输错误（`terminated`、`socket hang up`、`fetch failed`、DNS）、流提前结束（`stream ended before message_stop`）等大表
- **策略复用**：与 agent turn 重试共用 `settings.retry`（`agent-session.ts:1846/2252` 传 `settingsManager.getRetrySettings()`），注释明言"单一瞬时流断不再失败整个 compaction"
- **事件**：`_summarizationRetryCallbacks`（2785-2808）emit `summarization_retry_scheduled {attempt, maxAttempts, delayMs, errorMessage}` / `summarization_retry_attempt_start {source: compaction|branchSummary}` / `summarization_retry_finished`（类型定义 170-183）
- **abort**：`abortCompaction()`（2020-2023）同时 abort manual/auto controller；`compact()` 把 "Compaction cancelled"/AbortError 归类为 `aborted` 并 emit `compaction_end {aborted:true}` + `session_compact_failed`（1991-2011）

# G. 测试策略（可借鉴点）

**组织方式**：
- `test/suite/README.md`：faux provider（`packages/ai/src/providers/faux.ts`）+ 无网络 + 确定性；宽泛生命周期/特征测试直放 `test/suite/`，issue 回归放 `test/suite/regressions/`，命名 `<issue编号>-<短slug>.test.ts`（65 个回归文件）
- 统一 harness（`test/suite/harness.ts` `createHarness`）：in-memory SessionManager/Settings/Auth、脚本化 faux 响应（`setResponses` 支持 Promise 工厂做同步栅栏）、事件录制（`eventsOfType`）、harness 数组 + afterEach cleanup
- 纯函数层单测（`test/compaction.test.ts`：findCutPoint/split turn/buildSessionContext 多次压缩）+ agent 包 conformance 测试（`session/testing/conformance.ts:265` 固化 compaction entry 形状）

**值得 ohbaby 借鉴的故障场景清单**（按 pi 实际踩过的坑编号）：
| 场景 | 测试 | 核心断言 |
|---|---|---|
| 压缩中提交 prompt（RPC/SDK 面） | 7150 | 硬拒绝：错误信息、消息未持久化、零 agent 事件 |
| 压缩中提交 prompt（TUI 面） | suite/agent-session-compaction.test.ts:159 | 排队并在 compaction_end 后放行 |
| 响应进行中手动压缩 | 7253 | 只跑一次请求的压缩（manual 与 threshold 不叠加，compaction_start/end 各 1 次、entry 各 1 条） |
| Provider 零 usage / 无 usage | 8328 | 用消息估计；低于阈值不压缩 |
| 摘要调用瞬时失败 | 6647（5 个子用例） | transient 重试成功（调用数=1+N）、quota 类不重试、禁用时不重试、maxRetries 耗尽、abort 打断退避 sleep → aborted |
| 压缩 reason 透传 | 5217 | manual/threshold/overflow + willRetry 在扩展事件中正确 |
| /tree 取消后的压缩状态泄漏 | 3688 | `isCompacting` 复位、leaf 不动 |
| pre-prompt 溢出压缩 | pre-prompt-compaction-no-continue | length-stop 在新 prompt 前压缩且**不**从 assistant continue |
| 压缩后 stale usage 误触发 | agent-session-compaction.test.ts:585-716 | 压缩边界前的 usage/error 不再触发；错误消息用最后成功 usage；无任何 usage 不触发 |
| overflow 恢复单次护栏 | agent-session-compaction.test.ts:408-583 | 二次截断/溢出停止重试并给出文案 |
| 分支摘要环境凭证 | 6324 | branch summary 的 auth 解析不依赖交互环境 |
| 会话替换后上下文 | 2860 | 换 session 后 context 正确重建 |

**pi 方案中 ohbaby 可能遗漏的机制**（重点提示）：① `firstKeptEntryId` 指向**原始树节点**而非 compaction entry，使重复压缩天然链式衔接且 kept 消息可再参与摘要；② 锁在 `compaction_end` **事件 emit 之前**释放，允许监听者无缝续接 prompt；③ overflow 的"删末条 assistant → 压缩 → continue 一次"恢复路径及 `_overflowRecoveryAttempted` 单次护栏；④ stale pre-compaction usage 的 timestamp 边界判定（防压缩后立即误二次压缩）；⑤ compaction 与 turn retry 共用同一 retry 预算/分类器（`settings.retry` + `isRetryableAssistantError`）；⑥ 分支摘要（branch_summary）与压缩共用摘要基建但 entry 类型独立；⑦ lanes 设计——subagent 上下文隔离的"共享树多游标"方案（pi 尚在 scaffold 阶段，但其 durable operation/step_attempt 恢复模型值得对标）。