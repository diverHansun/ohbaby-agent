# llm-client 模块架构设计

## 当前状态

`core/llm-client` 是配置绑定的 provider-aware 流式执行层。它位于 `config/llm`、`services/interface-providers` 与上层 lifecycle/message/runtime 之间。

公开职责：

- `createLLMClient()`：读取 `config/llm`，调用 `services/interface-providers.createInterfaceProvider()` 创建 provider 实例，并保留当前模型配置。
- `streamChatCompletion()`：构造 `InterfaceProviderRequest`，调用 provider，消费归一化的 `InterfaceProviderStreamEvent`，累积流式文本与 tool call 参数，生成 `StreamingResponse`。

```text
config/llm
  -> core/llm-client.createLLMClient()
  -> services/interface-providers.createInterfaceProvider()

upper runtime/lifecycle
  -> core/llm-client.streamChatCompletion()
  -> provider.streamChatCompletion()
  -> normalized InterfaceProviderStreamEvent
  -> accumulated StreamingResponse
```

## 职责边界

`core/llm-client` 负责：

- 绑定已加载的 LLM 配置。
- 持有 provider 实例。
- 为单次请求填充 model、temperature、maxTokens、messages、tools。
- 将 provider stream 聚合成当前完整消息。
- 在完成态解析 tool call arguments。
- 在 abort 分支返回可用的 partial result。

`core/llm-client` 不负责：

- 不直接处理 OpenAI chunk、Anthropic SSE 等厂商原生事件。
- 不创建或管理 session/message/run 持久化。
- 不执行工具。
- 不做 token 估算或上下文压缩。
- 不维护模型元数据表。

## 与 Providers 的关系

provider 层只暴露稳定的小接口：

```typescript
interface InterfaceProviderInstance<TClient = unknown> {
  id: string;
  kind: "openai-compatible" | "openai-responses" | "anthropic";
  client: TClient;
  streamChatCompletion(
    request: InterfaceProviderRequest,
  ): Promise<AsyncIterable<InterfaceProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

llm-client 不知道 provider 内部如何调用 SDK，只消费归一化事件。

当前的 kind 选择与能力边界：

- `openai-compatible` 仍是缺省，使用 Chat Completions；`anthropic` 仍须显式选择。
- `openai-responses` 是第三个、仅手工配置后才会启用的 kind；factory 必须显式分支，未知 kind 不得回落到 Chat。
- core 输入消息仍是 Chat-shaped `ChatCompletionMessageParam`。Responses adapter 在 provider 边界投影它；这不是内部 canonical message 协议。
- Responses 本轮为无状态完整 replay（`store: false`，不传 `previous_response_id`），并且 prompt cache 只 observe usage，不发送 Responses cache 控制字段；它尚未与 Chat cache 对齐。
- 原生 reasoning/output-item continuation、assistant `phase`、refusal、annotation、hosted/custom tools 不在这个共享接口中表达，adapter 必须 fail-closed。lifecycle、context 和持久化没有因该 kind 改造。

## 与 llm-model 的关系

`services/llm-model` 只提供模型元数据、token 估算和上下文限制。llm-client 不调用其 token 估算逻辑，也不把 provider 返回的真实 `TokenUsage` 和估算值混用。

命名边界：

- `core/llm-client.ChatCompletionMessage`：provider/lifecycle 输入消息边界。
- `services/llm-model.TokenCountMessage`：token 估算输入结构。

两个类型不应混名，也不应互相承担对方职责。

## 设计取舍

1. 当前消息输入继续沿用 Chat-shaped `ChatCompletionMessageParam`，降低共享层改动；Responses adapter 将其投影为 wire 请求，但本轮不将它 canonical 化。
2. provider 创建只绑定连接级配置，model/temperature/maxTokens 在请求时传入。
3. tool call 参数只在完成态解析，避免流式片段中间态误解析。
4. abort 判断委托给 provider，partial response 构造保留在 llm-client。
