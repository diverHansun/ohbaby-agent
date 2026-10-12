# 第 3 批：现状与问题分析

> 基线代码 `c5cfda26`。本文诊断基线现状，给 [02](./02-optimization-plan-and-change-scope.md) 提供改动依据；不复述 [plan/01](../plan/01-problem-analysis-and-current-state.md) 的整体问题。所有锚点均在 `packages/ohbaby-agent/src/`（除注明外）。

## 1. 结论：本批要修的六处现状

| 现状问题 | 位置 | 本批处理 |
| --- | --- | --- |
| 摘要请求经字符串重建，不是同源 prepared 材料 | `adapters/ui-runtime/prompt-context.ts`、`core/context/types.ts` | 改为消费 prepared 请求 |
| 摘要前先 prune，可能先裁后失败 | `core/context/context-manager.ts` | 取消前置 prune 与 prune-only |
| 摘要输出额度未独立解析，容量检查不传摘要额度 | `services/llm-model/modelProfiles.ts` | 摘要额度独立、显式传 `requestedOutputTokens` |
| 重试多头：摘要外层 2 次 × SDK 隐式重试 | `core/llm-client/streaming.ts`、三个 provider | 单一重试所有者 + `maxRetries: 0` |
| 触发线偏高（0.95）且无必要提前保护 | `core/context/constants.ts`、`compaction-policy.ts` | 改 90%，接容量提前保护 |
| 摘要用量无归属；prune 专属代码与消费者仍在 | `core/context`、SDK/CLI/Web | 用量挂结果、失用代码同批清 |

## 2. 现状与代码锚点

### 2.1 摘要请求：字符串重建，非 prepared 材料

`ContextLLMClient.generateSummary` 接收 `history`、`prompt`、`systemPrompt`（`core/context/types.ts:51-62`）。实现 `createContextSummaryClient`（`adapters/ui-runtime/prompt-context.ts:81-147`）把历史 `serializeHistory(...)` 成一段字符串，拼成 `[system, user(历史), user(指令)]` 三条消息，用 `input.systemPrompt ?? input.prompt` 当 system。这与「同一份将要发出的正常请求材料 + 末尾指令」不符：没有 tools、没有既有消息顺序、没有原生状态、没有 resolved thinking 的发送字段，system 还可能被单独替换。

摘要生成方 `generateSummaryCandidate`（`core/context/context-manager.ts:811-975`）在**已 prune 后**的历史上运行，并循环两套提示词 `[COMPRESSION_PROMPT, AGGRESSIVE_COMPRESSION_PROMPT]`（`:867`）——这就是本批要取消的「提示词二次重做」入口。

### 2.2 前置 prune 与 prune-only 返回

压缩入口 `runCompactionCore` 在摘要之前无条件调用 `pruneHistory`（`core/context/context-manager.ts:1232-1258`，函数体 `:726-809`），随后按 `afterPruneRung` 决定是否继续摘要（`:1279-1293`）；若 prune 后不再需要摘要，直接返回 `status: "pruned"`（`:1286`）。也就是典型的「先裁后判断」：prune 会写 `time.compacted` 退场标记（经 `commitCompaction`），一旦后续摘要失败或被 Stop，这次裁剪已经提交、留在库里。相关专属符号：`PruneResult`（`core/context/types.ts:155-160`）、`CompactStatus` 的 `"pruned"`、`CompactResult.prune`、`pruneReducedContext`（`:1082-1120`）、`CompactionOutcome.prune/usageAfterPrune`（`:142-147`）、`getHistoryToCompress` 的比例分支（`compaction-policy.ts:214-238`）。

### 2.3 输出预算与容量检查

`calculateTokenBudget`（`services/llm-model/modelProfiles.ts:221-263`）在没传 `requestedOutputTokens` 时回退到 `profile.maxOutputTokens`（即 `/connect` 普通偏好），且 `reservedOutputTokens = min(requested, profile.maxOutput, maxOutputReservation(窗口))`；`maxOutputReservation` 是 `窗口 × MAX_OUTPUT_RESERVATION_RATIO`（0.5，`:423-429`）。`getContextUsage`（`compaction-policy.ts:42-74`）调 `getBudget?.(modelId, { usedInputTokens })`，**没传 `requestedOutputTokens`**，所以摘要容量检查当前会按普通偏好预留。这正是要修的「普通配置 4K、摘要却要预留 16K」错配。

触发判断 `needsSummaryCompaction`（`compaction-policy.ts:108-117`）已按 `currentTokens / contextLimit` 算占用、不含输出帽，这条是对的；`decideCompactionRung`（`:78-106`）里 mask 分支用 `usage.usageRatio >= thresholds.mask`，那个 `usageRatio` 才是带 50% 帽的口径，只服务 mask。

### 2.4 重试多头

摘要外层自带重试循环 `for (let attempt = 0; attempt < 2; ...)`（`prompt-context.ts:97`）；`generateSummaryCandidate` 又用 `MAX_SUMMARY_PROVIDER_ATTEMPTS = 4`（`constants.ts:22`）驱动溢出裁剪重试（`context-manager.ts:870`）。同时发送层 `streamResponse`（`core/llm-client/streaming.ts:260-292`）默认套用 `DEFAULT_PROVIDER_RETRY_POLICY.maxRetriesPerStep = 5`（`core/llm-client/retry.ts:15-20`）。三个 provider 建 client 时都不传 `maxRetries`（`openai-compatible.ts:443`、`openai-responses.ts:168`、`anthropic.ts:682`），SDK 自带的隐式重试仍在。三层叠加，实际请求数远超「首次＋一次」。

输出字段现状：Chat 写 `max_tokens`（`openai-compatible.ts:78`），Responses 写 `max_output_tokens`（`openai-responses.ts:155`），Anthropic 写 `max_tokens`（`anthropic.ts:397`）。发送层已支持 per-request `maxTokens` override 与 `purpose`（`streaming.ts:273-292`），这是本批落摘要独立额度的现成入口。缓存侧 `resolvePromptCacheRequest`（`core/llm-client/prompt-cache.ts:206-255`）对 `purpose !== "agent-step"` 一律 `observe-only`，所以摘要请求当前不走主动缓存控制。

### 2.5 用量与消费者

`ModelRequestRecord`（`core/llm-client/types.ts:257-271`）有 requestId／runId／messageId／step／attempt／purpose／时间／outcome，**没有 usage 字段**；会话消息的 `AssistantMessage.modelRequests`（`core/message/types.ts:47`）已是现成挂载点，`CommitCompactionInput.summary`（`:232-241`）当前只收 `{agent, text}`。prune 的对外面：事件 `ContextEvent.Pruned`（`core/context/events.ts:110-116`）、context 再导出 `PRUNE_*`（`core/context/index.ts:13-14`）、SDK 类型 `packages/ohbaby-sdk/src/compact.ts`（含 `pruned`、`prune`）、CLI 渲染 `packages/ohbaby-cli/src/tui/store/events.ts:1162`、Web 渲染 `apps/ohbaby-web/src/ui/commands/CompactOverlay.tsx:121`。

### 2.6 入口与调用链（本批要接的落点）

自动与手动两条入口最终都进 `runCompaction` → `runCompactionCore`（`core/context/context-manager.ts:1483-1515`、`:1185-1481`）：`prepareTurnUnlocked`（`:1553-1677`）先 `measureContext` 量一次、`reduceContextForModel` 做 mask，再调 `runCompaction`。手动压缩走 `compact` → `compactUnlocked`（`:1517`）。摘要生成、提交分别由 `generateSummaryCandidate`／`commitSummaryCandidate`（`:811-1018`）承担。也就是说：

- **材料只在一处造**：`assembleModelRequest`／`measureContext`（`:435-521`）已经是「造一次、量一次」的路径，摘要分叉应复用它，而不是另起 `serializeHistory` 字符串。
- **触发判断在一处**：`decideCompactionRung` 在 `runCompactionCore` 顶部（`:1197-1204`）；90% 与容量提前保护都改这里与 `needsSummaryCompaction`，不新增第二处判断。
- **退场在一处**：只有 `commitCompaction` 写 `time.compacted`（`core/message/database-store.ts`）；前置 prune（`:1232-1258`）是它的唯一多余调用点，本批删除。

## 3. 边界：本批不解决的（留批 4／5）

- 模式 A 受保护裁剪与遗漏记录、模式 B 保留段收缩、单滚动摘要、原子事务与最终失败终止：批 4（[plan/02 §5.4／§9](../plan/02-optimization-plan-and-change-scope.md)）。
- 无进展地板、删除 `MAX_COMPACTION_PER_TURN` 与抖动锁：批 4。
- mask 机制与其阈值、剩余旧机制复核：批 5。
- 本批不得「先裁后误退场」：唯一允许的退场是成功摘要事务的一部分（批 4 落地），本批失败／Stop 不得留下任何 prune 副作用。
