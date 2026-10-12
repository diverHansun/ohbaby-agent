# improve-1 参考项目

> 更新：2026-10-12。本地参考根目录：`/Users/hansun025/Projects/code-cli/`。
> 本批只涉及一个外部主题：**模型能力从哪来**。整体参考调查见 [`../plan/03`](../plan/03-reference-projects.md)，本文件不复述，只做本批相关的小范围核实与取舍。
> 说明：只借思路，不整套照搬；路径为本地 checkout，行号会漂移，定位以文件／符号为准。

## 1. 借鉴主题：不猜模型前缀

第 1 批要删掉 `BUILTIN_PROFILE_RULES`（12 条 provider／model 前缀 → 窗口／输出规则），把模型能力改成“用户配置 > provider 探测 > 默认值”三层。看一下相邻项目怎么处理未知模型。

### kimi-code（核实）

- 模型能力来自**运行时拉取的公共目录**，不是源码里的硬编码前缀表。`packages/agent-core-v2/src/app/kosongConfig/modelsDevUpstream.ts`：`MODELS_DEV_URL = 'https://models.dev/api.json'`、`CACHE_TTL_MS = 10 * 60 * 1000`（10 分钟缓存），并有构建期内联快照 `BUILT_IN_MODELS_DEV_JSON` 兜底。
- 唯一硬编码是 **Anthropic 家族的输出 clamp 表**，只管输出、只覆盖 Claude：`packages/agent-core-v2/src/human/llm/requester/bases/anthropic/profile.ts` 的 `inferAnthropicModelProfile()`／`matchUnknownClaudeProfile()`（未知 Claude 家族回退 `LATEST_OPUS_PROFILE`）。
- 与 ohbaby 的关系：方向一致，即**不猜前缀，能力来自目录／探测／用户**。但 ohbaby 本轮不引入 models.dev 目录（那是一条新的外部依赖和缓存链），只保留已有的三层。借“不猜前缀”的结论，不借目录机制。

### opencode（核实）

- `packages/core/src/models-dev.ts` 走 models.dev 动态目录（用 schema 描述目录结构），代码里没有前缀表。
- 与 ohbaby 的关系：同样只是印证“不猜前缀”。不照搬其目录／schema。

### pi（核实）

- `packages/coding-agent/src/core/model-config.ts`：`contextWindow` 与 `maxTokens` 是**显式模型配置里的可选字段**（`contextWindow: Type.Optional(PositiveTokenCountSchema)`、`maxTokens: Type.Optional(PositiveTokenCountSchema)`），能力由配置给出，不靠前缀推断。
- 与 ohbaby 的关系：印证“能力来自用户显式配置”。ohbaby 的 `models[].contextWindowTokens` 本就必填，方向一致。

### ZCode（plan 已核，本批未再取样）

- [`../plan/03`](../plan/03-reference-projects.md) §5.4 记录：ZCode 的 `contextWindow`／`maxOutputTokens` 是用户可填的可选字段，不在代码里猜。
- 与 ohbaby 的关系：同上。本批未重新取样，引用 plan 记录。

## 2. 对照表：能力来源

| 项目 | 能力来源 | 本批取舍 |
| --- | --- | --- |
| kimi-code | models.dev 公共目录＋`/models` 发现＋用户配置＋默认值；唯一硬编码是 Anthropic 输出 clamp 表 | 借“不猜前缀”结论，不引入目录机制 |
| opencode | models.dev 动态目录 | 同上，仅印证 |
| pi | 显式模型配置的可选字段 | 印证“能力来自用户显式配置” |
| ZCode | 用户可填的 contextWindow／maxOutputTokens | 同上（plan 记录） |
| ohbaby（本批目标） | 用户显式配置（`models[]` 窗口必填）> provider 探测（`probeContextWindow`）> 默认值兜底；`maxOutputTokens` 只来自 `llmParams.maxTokens` | 删 `BUILTIN_PROFILE_RULES`，保留三层 |

## 3. 不照搬的部分

- **不引入 models.dev 目录／缓存／内联快照**：ohbaby 已有 `probeContextWindow` 探测和用户配置，本轮不再加一条外部目录链（YAGNI）。
- **不照抄 kimi 的 Anthropic 输出 clamp 表**：ohbaby 的 `maxOutputTokens` 只来自用户 `llmParams.maxTokens`，不需要按家族 clamp。
- **不做溢出学习窗口**：kimi／Reasonix 有“从超窗错误解析真实窗口并收紧”的机制，本轮明确不做（见 [`../plan/03`](../plan/03-reference-projects.md) §5.6）。
- **不扩大探测范围**：`probeContextWindow` 只给窗口，不给 `maxOutputTokens`（现有单测明确忽略 `max_tokens`），本批不改这一点。

## 4. 与第 3 批参考的分工

本批只借“能力来源不猜前缀”这一条。以下属于第 3 批，不在本批展开，仅留指针：

- 摘要输出上限用**独立请求参数**、与普通偏好解耦（ZCode 摘要专用预算；Pi fixed “基础额度 ＋ B”）。
- 摘要总输出**没有共同的 32K 硬帽**，各协议各自解析。

见 [`../plan/03`](../plan/03-reference-projects.md) §3 与 [`../improve-3/03-reference-projects.md`](../improve-3/03-reference-projects.md)（待建）。
