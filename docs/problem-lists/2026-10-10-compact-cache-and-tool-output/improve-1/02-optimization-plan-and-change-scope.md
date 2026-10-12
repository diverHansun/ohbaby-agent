# improve-1 优化方案与改动范围

> 本文供后续开发者按方案实施、按 [04](./04-test-and-acceptance.md) 自测。本次只写文档。
> 依据：[00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md) 与 [plan/02](../plan/02-optimization-plan-and-change-scope.md) §4、§9。源码路径相对 `packages/ohbaby-agent/src/`，以符号名定位。

## 1. 目标与边界

本批修正计数和预算，并移除一条会让未读历史错误退场的摘要恢复分支。交付后应满足：

- 同一请求的发送额度和容量预留来自同一个解析结果，预留不再被 50% 帽截小。
- 模型真实能力、普通 `/connect` 输出偏好、摘要申请额度分开；不把普通偏好当成模型硬上限。
- 尾段与完整请求按同一份实际回传表示计数，包含工具 metadata、活动 reasoning 和原生状态。
- usage 缺失与 0 分开；reasoning 是 output 子项，cache 是 input 分类，不重复加入总量。
- 摘要超窗时不再缩小输入后按原集合退场。前置 prune 在第 3 批删除，本批的保证针对摘要覆盖与提交范围。

本批不改变摘要请求形状、缓存策略和工具存储，不删除 prune／mask，不实现模式 A／B、滚动摘要或新的入口调度。

## 2. 职责与数据流

```text
用户配置 + 既有窗口探测 + 默认值
  → 分开解析模型能力与本次输出偏好
  → 同一个实际输出额度 → 发送参数 / 容量预留

历史 + 活动 reasoning + 模型来源
  → 正式模型投影 → 尾段估算 / 完整请求估算

provider usage
  → 现有归一化与聚合 → ModelRequestRecord 的可选 usage
```

`llm-model` 保留预算解析职责；配置层解析和写入普通偏好；provider 层处理协议与真实用量；Context 消费同源计数。MessageStore 的事务在本批不改。

## 3. 开发阶段

### Stage 1.1：发送与预留使用同一额度

以 `calculateTokenBudget` 为现有解析入口，让 `reservedOutputTokens` 表示本次请求完整的实际输出额度。`inputBudgetTokens`、`remainingInputTokens` 和容量判断据此计算，不再受 `maxOutputReservation` 的 50% 帽限制。

mask 尚未删除：只在其触发路径局部派生旧比率，保持该路径原有时序，随第 5 批一起移除。自动摘要继续用 `needsSummaryCompaction` 的 `currentTokens / contextLimit`；不新增第二套总预算字段。

`requestedOutputTokens` 显式传入时，不能再被普通 `profile.maxOutputTokens` 偏好截小。未显式传入时沿用普通请求配置。核对 `getContextUsage`、发送层 `requestMaxTokens` 和 overflow 容量消费者；第 3 批负责将摘要自己的额度接入此入口。

保持 `resolveRequestReasoning` 的 fixed B 校验：B 不自动降低，输出总额必须容纳 B；真实能力不允许时明确报不兼容，不新加 32K 硬帽。fixed 摘要的正文基础＋B、effort/adaptive 的试行额度由第 3 批设置。

完成条件：普通与显式 override 的发送值、预留值一致；mask 比率与摘要触发、容量判断分清。

### Stage 1.2：删除内置档位表，统一普通缺省

- 删除 `services/llm-model/modelProfiles.ts` 的 `BUILTIN_PROFILE_RULES` 及其专属类型、来源标签和辅助代码：`findBuiltinProfile`、`modelKeyCandidates`、`inferProvider`、`isKnownBuiltinProvider`、`ruleToProfile`、无调用方的 `list()` 与 `dedupeProfiles`。按引用关系确认删除范围。
- `resolve()` 改为 user > fallback。现有探测窗口已经进入 `defaultLimit`／fallback，删表后不再被模型名前缀覆盖；用户 profile 的 id、provider+model、bare key 路由保留。
- 删除 `config/llm/apply-active-model-config.ts` 的 builtin 输出回填，普通输出偏好直接来自 `llmParams.maxTokens`。这个值不代表独立探测到的真实输出 cap。
- 将 `config/llm/writer.ts` 的 `DEFAULT_MAX_TOKENS = 4096` 及 `apply-active-model-config.ts` 两处 `?? 4096` 统一为 8192；`modelProfiles.ts` 已有的 8192 保留。
- 保留 `probeContextWindow`，它只探测窗口，不扩成输出能力探测或模型目录服务。

完成条件：未配模型窗口时探测／默认值真正生效；未配普通输出时统一 8192。实施说明要写明：未配置输出的模型不再继承 builtin 的大输出值，用户仍可显式设置。

### Stage 1.3：尾段与完整请求按同一投影计数

`estimateHistoryForCompaction` 增加并向下传递 `activeReasoningByMessageId` 和模型来源。有原生依赖、无原生依赖两条路径都复用正式模型投影，不能只修 `serializeHistoryMessages` 的参数，却留下另一条 `serializeHistory` 的可读文本估算路径。

这同时补上工具 `<tool_metadata>` 漏计和兼容内存 reasoning 漏计。调用方 `getHistoryToCompress` 及上游传入同一份活动 reasoning；第 4 批的尾段选择直接消费结果。

继续用现有 `TokenCounter`、原生状态估算和投影。给人看的 reasoning 不再额外复制或计数；不回传的旧思考不累计；opaque 代理值保留来源与不确定性，不按密文字符数冒充精确值。

完成条件：同一组历史的实际可回传表示一致；固定请求开销另计，不要求尾段总数等于包含 system／tools 的完整请求总数。

### Stage 1.4：补可选 usage 基础

- `services/interface-providers/types.ts` 的 `InterfaceProviderTokenUsage` 增加可选 `reasoningTokens`，沿 `token-usage.ts` 和既有 metadata／聚合链路传递。它属于 output，不再次加入 total；大于 output 的不合理值丢弃或标未知，保留可信总量。
- `core/llm-client/types.ts` 的 `ModelRequestRecord` 增加可选 `usage?: TokenUsage`。缺失保持 `undefined`，不以 0 兜底，不新增用量表。
- 本批补结构和归一化；第 3 批填摘要请求记录，第 4 批将成功记录与摘要同事务保存。

跨批所有权已统一：第 3 批按 `purpose` 建立请求记录的判别变体。普通 `agent-step` 的 `runId／messageId／step` 保持必填；自动和手动 `context-summary` 都用请求前在内存预分配的 `summaryMessageId` 作为 `messageId`，`compactionId` 复用现有 attemptId。不得伪造普通 run，不能把自动摘要记录挂到普通 assistant 消息上。

完成条件：旧记录仍可读；未知不变成 0；reasoning 和 cache 不重复计入总量。

### Stage 1.5：移除危险的缩水恢复

在 `generateSummaryCandidate` 删除 `shrinkSummaryHistory` 超窗恢复分支。摘要调用报超窗后直接返回失败，不发缩水后的第二次请求，不创建摘要候选或按原集合提交摘要覆盖退场。

该分支删除后，摘要成功候选与实际发送范围保持一致。这里不承诺尚未删除的前置 prune 没有副作用；相关测试隔离 prune，专门验证摘要失败不会追加错误退场。第 3 批同批删除前置 prune，第 4 批再按受保护选择和显式遗漏记录实现模式 A。

同批删除失用的 `core/context/summary-overflow.ts`，以及 `droppedRounds` 的生产逻辑、`ContextEvent.CompactionProgress` schema、`bus/event-catalog.ts` 登记字段和专属测试。已核查此字段只有测试消费，无 CLI／Web／SDK 消费。保留进度事件本体及仍使用的 attempt、estimatedHistoryTokens，不留兼容空壳。

保留 `commitCompaction`、`time.compacted`、工具配对、原生依赖校验和旧会话读取；不撤销旧记录已有退场标记。

## 4. 依赖、兼容与风险

本批无前置依赖，可先合入。[第 3 批](../improve-3/02-optimization-plan-and-change-scope.md) 消费预算、计数和 usage 基础并接上摘要所有权；[第 4 批](../improve-4/02-optimization-plan-and-change-scope.md) 消费请求结果、实现选择和原子提交。

不做数据库 schema 迁移，usage 是现有记录里的可选内容。回退须保持已存记录可读，也要说明 builtin 输出偏好可能恢复的影响；不清除历史或无条件恢复全部退场内容。

重点风险是预算字段的多处消费者、无原生状态路径漏修、未知 usage 被填成 0，以及超窗测试被前置 prune 干扰。按 [04](./04-test-and-acceptance.md) 验证这些行为，不借本批扩大工具投影格式、重试策略或入口改造范围。
