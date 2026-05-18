# llm-client 模块架构设计

## 当前状态

`core/llm-client` 是配置绑定的 provider-aware 流式执行层。它位于 `config/llm`、`services/providers` 与上层 lifecycle/message/runtime 之间。

公开职责：

- `createLLMClient()`：读取 `config/llm`，调用 `services/providers.createProvider()` 创建 provider 实例，并保留当前模型配置。
- `streamChatCompletion()`：构造 `ProviderRequest`，调用 provider，消费归一化的 `ProviderStreamEvent`，累积流式文本与 tool call 参数，生成 `StreamingResponse`。

```text
config/llm
  -> core/llm-client.createLLMClient()
  -> services/providers.createProvider()

upper runtime/lifecycle
  -> core/llm-client.streamChatCompletion()
  -> provider.streamChatCompletion()
  -> normalized ProviderStreamEvent
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
interface ProviderInstance<TClient = unknown> {
  id: string;
  kind: "openai-compatible" | "anthropic";
  client: TClient;
  streamChatCompletion(
    request: ProviderRequest,
  ): Promise<AsyncIterable<ProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

llm-client 不知道 provider 内部如何调用 SDK，只消费归一化事件。

## 与 llm-model 的关系

`services/llm-model` 只提供模型元数据、token 估算和上下文限制。llm-client 不调用其 token 估算逻辑，也不把 provider 返回的真实 `TokenUsage` 和估算值混用。

命名边界：

- `core/llm-client.ChatCompletionMessage`：provider/lifecycle 输入消息边界。
- `services/llm-model.TokenCountMessage`：token 估算输入结构。

两个类型不应混名，也不应互相承担对方职责。

## 设计取舍

1. 当前消息输入继续沿用 OpenAI-compatible 的 `ChatCompletionMessageParam` 形状，降低 provider 适配成本。
2. provider 创建只绑定连接级配置，model/temperature/maxTokens 在请求时传入。
3. tool call 参数只在完成态解析，避免流式片段中间态误解析。
4. abort 判断委托给 provider，partial response 构造保留在 llm-client。
