# improve-1 现状、问题与证据

> 本批规划日期：2026-10-12。代码基线 git HEAD：`c5cfda26`。行号为调查快照，定位以函数名为准。
> 需求与边界见 [00](./00-discussion.md)，改动面见 [02](./02-optimization-plan-and-change-scope.md)。整体现状与系统级问题见 [`../plan/01`](../plan/01-problem-analysis-and-current-state.md)，本文只写第 1 批相关部分。
> 除特别说明，路径相对于 `packages/ohbaby-agent/src/`。

本批只覆盖三类现状问题：**计量算错**（预算同源、reasoning 计数）、**能力与偏好混用**（内置档位表、缺省值不一致、用量结构缺字段）和一处**独立退场 bug**（超窗恢复缩小输入却扩大退场范围）。不重复工具投影（第 2 批）和请求形状（第 3 批）的问题。

## 1. 预算：发送值与预留值不是同一个数

`calculateTokenBudget()` 算出的 `reservedOutputTokens` 会被 50% 帽截断，而真正发送的值另有来源：

- `services/llm-model/modelProfiles.ts:221` 的 `calculateTokenBudget()` 里，`reservedOutputTokens = min(requestedOutputTokens, profile.maxOutputTokens, maxOutputReservation(...))`（`:236-240`），`maxOutputReservation` 把预留压到“可用窗口的 50%”以内（`:4`、`:423-429`）。
- 真正发送的输出上限由 `core/llm-client/streaming.ts:291` 决定：`requestMaxTokens = validateRequestMaxTokens(maxTokens) ?? config.maxTokens`。`maxTokens` 是本次调用的 override，缺省回退 `config.maxTokens`。
- `core/context/compaction-policy.ts:42` 的 `getContextUsage()` 只把 `usedInputTokens` 传进预算解析（`:47-49`），没有传本次请求的真实输出额度，因此容量判断用的预留值可能小于实际发送值。

后果：本地“只预留小值、实际发送大值”，容量检查偏乐观。这个偏差正是第 3 批容量保护要修的根，第 1 批先把解析层理顺，使发送值与预留值能来自同一个已解析结果。

> 注意（以磁盘最新 plan 为准）：50% 帽（`maxOutputReservation`）**只在自动触发 `usageRatio` 里**服务 mask 判断（`core/context/compaction-policy.ts:78` 的 `decideCompactionRung`，`usageRatio >= thresholds.mask`），mask 随第 5 批删除；它**不进模式 A／B 的容量检查**。自动摘要触发本身用的是完整窗口占用 `currentTokens / contextLimit`（`needsSummaryCompaction`，`:108`），不含输出帽。参见 [`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §4.3。

## 2. 能力与偏好混用：内置档位表劫持探测值

模型窗口和输出上限有一部分来自一张硬编码前缀表，和已有的探测机制平行，而且优先级排反：

- `services/llm-model/modelProfiles.ts:69-142` 的 `BUILTIN_PROFILE_RULES`：12 条 provider／model 前缀 → 窗口／输出规则（如 `gpt-5` → 400K 窗口、128K 输出；`claude-` → 200K、8K）。
- `resolve()`（`:169-204`）顺序为 user > builtin > fallback。provider 探测值经 `tokenCounting.ts` 的 `defaultLimit`／`fallbackContextWindowTokens` 进入 **fallback**（`services/llm-model/tokenCounting.ts:45-56`），于是被 builtin 前缀命中覆盖。
- 只有 builtin 使用的辅助函数：`findBuiltinProfile`（`:288`）、`modelKeyCandidates`（`:324`）、`inferProvider`（`:439`）、`isKnownBuiltinProvider`（`:320`）、`ruleToProfile`（`:334`）、`list()`（`:213`）与 `dedupeProfiles`（`:431`）。
- 探测入口是 `config/llm/context-window-probe.ts:43` 的 `probeContextWindow()`，被 `config/llm/apply-active-model-config.ts:165`、`:283`、`:558` 调用；探测结果不含 `maxOutputTokens`（单测明确忽略 `max_tokens`）。

输出上限的另一处混用：

- `config/llm/apply-active-model-config.ts:298-303` 先 `createModelProfileRegistry(...).resolve(...)`，再 `resolvedMaxOutputTokens = maxOutputTokens ?? (profile.source === "fallback" ? undefined : profile.maxOutputTokens)`。这使 builtin 的拍脑袋输出上限被当成“真实能力”写回。
- 随后 `:316-317` 把同一个 `resolvedMaxOutputTokens` 同时写进 `maxOutputTokens`（模型 profile 能力）和 `maxTokens`（普通请求偏好），两个含义混成一个值。
- `config/llm/manager.ts:47-52` 也会把 `llmParams.maxTokens` 作为 profile 的 `maxOutputTokens`。

缺省值不一致：

- `config/llm/writer.ts:30` 的 `DEFAULT_MAX_TOKENS = 4096`（`:131` 使用），而 `services/llm-model/modelProfiles.ts:2` 的 `DEFAULT_MAX_OUTPUT_TOKENS = 8192`。
- `config/llm/apply-active-model-config.ts:188`、`:578` 还各有一处字面量 `?? 4096`。

参考项目提供了目录和显式配置的做法，但不能概括为都不推断模型前缀；Kimi 仍有 Anthropic 输出推断。本批沿用自己的用户配置 > 探测 > 默认值链路，删除内置前缀表，不新增外部模型目录。对照见 [03](./03-reference-projects.md)。

## 3. 计量：尾段估算与完整请求估算不同源

同一批历史，尾段估算和完整请求估算用的可回传表示不一致，兼容内存 reasoning 路径会漏计：

- `core/context/compaction-policy.ts:26` 的 `estimateHistoryForCompaction()`：有原生依赖时调 `serializeHistoryMessages(history, undefined, modelOrigin)`（`:33-39`），第二个参数（活动 reasoning 映射）是 `undefined`；无原生依赖时走可读历史序列化 `serializeHistory()`。
- 完整请求估算 `core/context/token-estimation.ts:61` 的 `estimatePreparedRequestHeuristic()` 会把有原生状态的 assistant 消息额外算一次原生状态（`:74-82`）；`estimateContextOccupancyComposition()` 还从 `activeReasoningByMessageId` 取兼容 reasoning 文字（`:129-141`、`serializeForLlm` 入参 `:91`）。
- 结果：在“缺少原生状态、仍有内存 reasoning 回传”的兼容场景，尾段估算可能少算。讨论记录 §8.6 由静态链路确认了这处差异，本轮没有针对它的复现测试。
- 尾段选择 `getHistoryToCompress()`（`core/context/compaction-policy.ts:214`）用的就是 `estimateHistoryForCompaction`，所以尾段预算受影响。

“显示用 reasoning 不重复算”的规则已有基础：`core/context/serializer.ts` 从持久化 part 恢复原生状态，给人看的 reasoning part 不会再复制进模型输入；opaque 状态用 usage／请求限额的保守代理值（`core/llm-client/streaming.ts:595`）。本批要保证的是**同一投影被估算与发送共用**，不新增第二套计数。

## 4. 用量结构：标准用量缺 reasoning 子项，请求记录缺 usage

- provider 层已经读到 reasoning 明细：Chat `services/interface-providers/openai-compatible.ts:183`、Responses `openai-responses-stream.ts:100`、Anthropic `anthropic.ts:709`；`services/interface-providers/types.ts:161` 已声明可选 `reasoningTokens?`。但它主要用于原生状态估算（`streaming.ts:595`），没有贯穿标准 `TokenUsage`、普通用量聚合和消息 usage metadata。
- 标准总量口径正确：`services/interface-providers/token-usage.ts:100` 的 `tokenUsage()` 是 `input + output`，reasoning 未再加一次；cache read／write 在归一化层已并入 input。
- 请求记录 `core/llm-client/types.ts:257` 的 `ModelRequestRecord` 有 `requestId`、`runId`、`messageId`、`step`、`attempt`、`purpose`、起止时间、`outcome`，**没有 usage 字段**。普通请求通过消息 metadata 持久化这些记录。
- 因此“缺失”与“0”还无法在记录层区分；摘要用量在第 1 批也还没有落点（挂摘要消息的 `modelRequests` 是第 4 批落地，见 [`../plan/02`](../plan/02-optimization-plan-and-change-scope.md) §6.1）。本批只补可选结构。

## 5. 退场 bug：超窗恢复缩小输入、却扩大退场范围

`core/context/context-manager.ts` 的 `generateSummaryCandidate()`：

- `:862` 用可变的 `summaryHistory` 作为本次摘要请求实际发送的历史，初值等于 `historyToCompress`。
- 摘要请求抛超窗错误时，`:925-941` 调 `shrinkSummaryHistory()`（`core/context/summary-overflow.ts:47`）缩小 `summaryHistory`，并在 `:870` 的循环里用缩水后的历史重试。
- 但成功后返回的候选（`:967-974`）用的是**原始** `historyToCompress`，不是缩水后的 `summaryHistory`。
- `commitSummaryCandidate()`（`:977`）按 `candidate.historyToCompress` 平铺出 `expectedParts`（`:988`）并标记退场。

后果：被缩小掉（从未进入成功摘要请求）的较早原文，也被标记为已退出活动视图；这些独有信息随之离开模型上下文。这正是整体议题的问题 P4（[`../plan/01`](../plan/01-problem-analysis-and-current-state.md) §1）。

**本批的处理边界**：模式 A（显式遗漏记录 ＋ 精确退场）在第 4 批才接入，本批先移除这条“缩水输入却扩大退场范围”的危险分支，保证未读且无遗漏记录的 parts 始终不退场。相关死代码（`summary-overflow.ts`、进度事件里的 `droppedRounds`）按“失去引用”原则在第 1 批一并评估清理，是否触及对外事件字段需与主代理确认（见 [02](./02-optimization-plan-and-change-scope.md)）。

## 6. reasoning 预算解析与不暗降 B

- `services/interface-providers/reasoning.ts:266` 的 `resolveRequestReasoning()` 已有校验（`:341-350`）：fixed budget 必须显式映射、达到最小额度，且**严格小于 `maxTokens`**；不合规则报错，不会自动 clamp B。
- 现状没有内置 32K 硬帽，`/connect` 也没有数字 thinking 输入框；fixed B 来自可编辑 model profile 的 `reasoningCapabilities.budgets[effort]`（讨论记录 §13.2）。
- 本批要保住的性质：**不新增任何人造 32K 帽，也不因额度变化在底层暗中降 B**。B 大于正文 16K 只意味着正文可用空间更少，不等于失败；真正的不兼容只按模型／协议能力判断（如实际 cap ≤ B）。

## 7. 已有验证与非功能要求

- 既有多轮调查已运行的相关测试：`native-context`、`token-estimation`、`tokenCounting`、`modelProfiles` 四文件 51 项；`database-store`、`atomic-model-step` 两文件 40 项。它们证明部分现有估算、持久化和事务行为，不等于新方向已实现。来源：[`../plan/01`](../plan/01-problem-analysis-and-current-state.md) §7。
- 调查期间没有调用真实模型 API，本批规划也没有。真实 usage、reasoning 子项和实际输出参数的核对属于本批**收尾**动作（见 [04](./04-test-and-acceptance.md) §4）。
- 本批主要风险：预算解析改错导致发送值与预留值反而更不一致、删表后探测值没有真正生效、可选字段被误填成 0、移除恢复分支后超窗无兜底。对应用例在 [04](./04-test-and-acceptance.md)。

## 8. SWE 判断

本批的复杂度来自“同一事实有多个预算口径、同一能力有三个来源”。改造方向是**减少分叉**：预算只解析一次、能力只保留三层且顺序正确、计数只共用一份投影、用量只在一处补可选字段。不引入预算预测器、第二套 thinking 计数或计费框架。改动集中在 `core/context` 计量、`services/llm-model`、`services/interface-providers`、`config/llm` 和现有请求记录链路，落点见 [02](./02-optimization-plan-and-change-scope.md) §5。
