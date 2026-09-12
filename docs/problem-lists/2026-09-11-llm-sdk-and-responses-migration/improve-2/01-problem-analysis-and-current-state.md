# 1. 问题基线与当前实施状态

> 时间口径：improve-1 已实施并通过本地 `pnpm preflight`（见 improve-1 `05-implementation-acceptance.md`）。分析基线为当前工作区代码，OpenAI SDK `7.13.0`，Anthropic SDK `0.124.0`。Responses 协议仍未接入。

## 1.1 问题陈述

1. **协议缺口**：官方 OpenAI 新能力优先走 `/v1/responses`，仓库只有 Chat Completions 与 Anthropic Messages。
2. **内部仍是 Chat 形状**：`InterfaceProviderRequest.messages` 是 `ChatCompletionMessageParam[]`；lifecycle 不需要懂 SSE，但请求边界锁在 Chat 上。
3. **工厂只有两扇门**：未写或非 anthropic 一律 `openai-compatible`，没有显式 Responses kind。
4. **cache 策略硬编码 Chat**：`resolvePromptCacheStrategy` 只认 `openai-compatible`；**仅 `policy === "enabled"`** 时，非 Chat kind 会掉进 Anthropic `cache_control`。`auto` 下未知 kind 已是 observe-only，但仍必须给 `openai-responses` 显式开口，避免以后改策略表再漏。
5. **usage 解析是 Chat 字段名**：`normalizeOpenAICompatibleUsage` 读 `prompt_tokens` / `completion_tokens`。Responses 是 `input_tokens` / `output_tokens`，不能靠字段嗅探（Anthropic 也用 `input_tokens`）。
6. **原生续接信息无落点**：Responses reasoning item（尤其 `encrypted_content`）与 assistant `phase` 需要在手工管理上下文时原样回传；当前 `InterfaceProviderStreamEvent`、`PreparedModelRequest` 和 Chat-shaped 历史都没有无损落点。若本轮直接丢弃后继续工具多轮，会形成“测试能拼 Chat 消息、真实推理状态已丢”的假成功。

## 1.2 已确认的产品/技术分界

引用 00：本轮新增独立 adapter，共享现有接口；默认 Chat；不对用户露出；wire-complete、capability-limited；cache 只做 observe-only 防掉坑；lifecycle / context / SQLite 行为不动。为守住该边界，本轮遇到 reasoning item、assistant `phase` 或其他无法无损表示的输出必须 fail-closed。

```text
lifecycle / context / llm-client 累积器
        ↓  现有 InterfaceProviderRequest（Chat 形状）
┌─────────────────────────────────────────────┐
│ openai-compatible.ts  Chat Completions      │  默认
│ openai-responses.ts   Responses             │  显式 kind · 本轮新增
│ anthropic.ts          Messages              │
└─────────────────────────────────────────────┘
        ↓  现有 InterfaceProviderStreamEvent
```

## 1.3 interface-providers 现状

### 1.3.1 goals-duty

职责应是：把项目请求投影到各家 wire，把各家流归一成 `InterfaceProviderStreamEvent`。当前只有两个实现。`openai-compatible.ts` 绑定 `client.chat.completions.create()`；`anthropic.ts` 绑定 `messages.stream()`。没有人负责 Responses 事件联合。

### 1.3.2 architecture

工厂在 `packages/ohbaby-agent/src/services/interface-providers/index.ts` 的 `createInterfaceProvider`：`anthropic` 否则 Chat。类型 `InterfaceProviderKind` 在 `services/interface-providers/types.ts` 与 `config/llm/types.ts` 各有一份，目前都是 `"openai-compatible" | "anthropic"`。

improve-1 已把 tools 收到 `InterfaceProviderFunctionTool`；消息仍泄漏 OpenAI Chat 类型。

### 1.3.3 data-model

统一请求：`InterfaceProviderRequest`（`types.ts`）。统一事件：text / reasoning / toolCallDeltas（含数字 `index`）/ finishReason / tokenUsage。Cache 意图：`InterfaceProviderPromptCache`。Usage：`InputTokenBreakdown`（uncached / cacheRead / cacheWrite）。

Responses 原生 item、response id、hosted tools **没有**对应统一字段。对单纯诊断字段可以验证后丢弃；对后续轮次必须回传的 reasoning/phase，这会直接限制本轮支持能力，不能再把它写成“只观察、不影响正确性”。

### 1.3.4 dfd-interface

```text
PreparedModelRequest（context）
  → llm-client.streamChatCompletion
  → InterfaceProviderRequest
  → adapter SDK 调用
  → InterfaceProviderStreamEvent
  → streaming.ts 按 index 累积 tool calls
  → lifecycle 调度工具
```

llm-client `streaming.ts` 用 `toolCall.index` 作为 Map 键。Responses 的 `call_id` 若不在 adapter 合成 index，现有累积器无法工作。

`core/context/serializer.ts` 会把项目消息重新投影为 Chat assistant/tool 消息；活跃 reasoning 仅以非标准 `reasoning_content` 文本回填，不能表达 Responses `ResponseReasoningItem` 的 opaque 状态或 assistant item `phase`。官方 SDK 对 `ResponseReasoningItem` 的约束是：手工管理上下文时要在后续请求回传完成后的 item，`store: false` 时尤其重要。因此本轮不能同时声称“丢弃 reasoning item”和“推理模型工具多轮正确”。

### 1.3.5 use-case

用户配置 `model.json` 的 `apiConfig.interfaceProvider` 缺省为 Chat。connect-model、writer、UI 均按两种 kind 测试。没有「选 Responses」用例，也不应在本轮变成用户功能。

### 1.3.6 non-functional

Chat 路径始终 `stream_options.include_usage: true`。abort 走 SDK `APIUserAbortError`。cache 控制仅官方 OpenAI Chat 发 `prompt_cache_key`（`prompt-cache-wire.contract.test.ts`）。这些质量属性本轮不得被 Responses 接入破坏。

### 1.3.7 test

已有 `openai-compatible.test.ts`、`anthropic.test.ts`、`prompt-cache-wire.contract.test.ts`、`token-usage.unit.test.ts`、`prompt-cache.unit.test.ts`。没有 Responses fixture、没有「未知 kind 不得落入 Anthropic cache」的守卫测试，也没有 reasoning/phase/refusal/annotation 的拒绝测试。真实 cache/smoke 在 improve-1 为可选未跑。

## 1.4 llm-client / lifecycle / context 现状

- `core/llm-client/streaming.ts`：`streamChatCompletion` 对外函数与 provider 方法同名；累积 Chat 形状 `completeMessage`，无法携带原生 Responses output item。
- `core/llm-client/prompt-cache.ts`：`resolvePromptCacheStrategy` 在 `enabled` 下非 `openai-compatible` 会走到 Anthropic 策略（约 L130–152）。
- `core/lifecycle/lifecycle.ts`：消费归一化流与工具调度，不解析 SSE。
- `core/context/types.ts`：`PreparedModelRequest.messages` 为 `ChatCompletionMessage[]`。
- SQLite 存项目 message/parts，非 SDK response 对象。

本轮这些模块的**行为**不是问题；问题是若 adapter 把 Responses 专属字段或错误 cache 策略泄漏上去，才会扩散。

## 1.5 跨模块一致性

`config/llm/validation.ts` 与 `config/llm/apply-active-model-config.ts` 各有一份 `INTERFACE_PROVIDER_KINDS`，目前都只允许两种 kind。只改 validation 不够：connect/apply 路径仍会拒收 `"openai-responses"`。`context-window-probe.ts` 已能识别 URL 以 `/responses` 结尾为非法 baseUrl 后缀，说明配置层知道 Responses 路径存在，但 kind 白名单尚未承认它。

`packages/ohbaby-sdk/src/connect-model.ts` 当前把“connect 表单可选择的 kind”和“current-model 可回显的 kind”共用为两值联合。内部配置加入第三值后，`adapters/ui-inprocess.ts` 会把更宽的 current config 透传到更窄的 SDK 类型，强制 tsc 失败。边界需要拆开：connect/probe 的选择与 URL 推断仍只产生 Chat/Anthropic；current-model 的只读回显类型可认识 `openai-responses`。这不等于新增 UI 切换入口。

usage diagnostic 也有两处静态闭集：`observability/events.ts` 的 `protocol` enum 与 `observability/logger.ts` 的安全枚举。仅扩 `token-usage.ts` 会造成类型或模块加载校验失败，必须与第三 protocol 同步。

context 会把 `tailDirectives`（可为额外 `system`）拼进 `PreparedModelRequest.messages`（`context-manager.ts`）。adapter 翻译不能只处理「第一条 system」。

权威文档 `docs/core/llm-client/architecture.md` 仍写 kind 仅两种、消息继续 Chat 形状。与本轮目标「第三种 kind、消息暂不 canonical」可并存，实施后需改文档中的 kind 联合，不得改成「内部已是 Responses IR」。

## 1.6 改动影响面（现状视角）

| 层 | 现状耦合 | 本轮预期触达 |
| --- | --- | --- |
| config/llm types + validation + tests | kind 白名单 | 必须 |
| ohbaby-sdk current-model 类型 / UI runtime | connect 与回显共用两值联合 | 必须拆分只读回显联合；connect/probe 不开放 Responses |
| interface-providers factory / types | 两实现 | 必须新增第三实现 |
| openai-compatible.ts / anthropic.ts | 现有 wire | 原则上不改行为 |
| prompt-cache.ts | kind 分支 | 仅加 responses → observe-only |
| token-usage.ts | Chat/Anthropic parser | 新增 Responses parser，按 kind 调用 |
| observability events / logger | usage protocol 两值闭集 | 必须加入 `openai-responses` 并回归 redaction/枚举校验 |
| llm-client streaming / lifecycle / context | Chat 累积，无 Responses continuation 落点 | 不改控制流；只接受无需原生续接的合成 index 路径，其他路径 fail-closed |
| UI / CLI | 无开关 | 不改产品入口 |
| SQLite | 自有 DTO | 不改 |

## 1.7 SWE 原则审视摘要

- 本质复杂度是「第三条协议」；偶然复杂度是把 Responses 塞进 Chat 文件或把全部原生字段抬到共享接口。
- improve-1 已证明：只抽已有共性（function tools）是对的。本轮同样：认识完整放在 adapter，共享接口保持现有能力。
- YAGNI：不预埋默认 Responses、不预造 canonical IR、不把 Chat cache 对齐复制过去。
- Fail-closed：暂不设计 continuation envelope，就必须拒绝无法无损降级的 reasoning/phase/refusal/annotation；不能以“过渡期”为理由静默丢语义。
- 可逆：新文件 + factory 分支 + kind 白名单，默认路径不变，可删回滚。
- 一扇门：把 `previous_response_id` 或显式 cache 写进共享接口/SQLite 才是难回退的；00 已禁止。

## 1.8 与既有文档关系

| 文档 | 关系 |
| --- | --- |
| improve-1 02/05 | 权威：本轮不得宣称 improve-1 已含 Responses |
| investigation/00–03 | 背景：独立 provider、保留 Chat 基线 |
| 知识库 migration-strategy | 曾建议先 canonical 再 Responses；00 已改为本轮 adapter 过渡 |
| `docs/core/llm-client/*` | 实施后同步 kind 与「未默认 Responses」；不改成 canonical 已完成 |
