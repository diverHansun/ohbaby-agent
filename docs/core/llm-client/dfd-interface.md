# llm-client 模块的数据流与接口设计

## 上下文与范围

当前 llm-client 位于配置层、provider 层和上层业务之间：

- `config/llm` 提供 `LLMConfig`
- `services/providers` 提供 `ProviderInstance`
- `streamChatCompletion()` 向上游输出 `StreamingResponse`

本文档描述当前已实现的数据流。

## 数据流描述

### 流程 1：创建 LLMClientInstance

```text
getLLMConfig()
    ↓
读取 provider / model / apiKey / baseUrl / temperature / maxTokens
    ↓
createProvider({ provider, apiKey, baseUrl })
    ↓
返回 LLMClientInstance {
  provider,
  config: { provider, model, baseUrl, temperature, maxTokens }
}
```

### 流程 2：发起流式请求

```text
streamChatCompletion(llmClient, messages, options)
    ↓
构造 ProviderRequest {
  model,
  messages,
  temperature,
  maxTokens,
  tools?,
  signal?
}
    ↓
provider.streamChatCompletion(request)
    ↓
获得 AsyncIterable<ProviderStreamEvent>
```

### 流程 3：累积归一化事件

```text
逐个处理 ProviderStreamEvent
    ├─ textDelta            → accumulatedContent
    ├─ toolCallDeltas       → accumulatedToolCalls
    ├─ finishReason         → 完成态判断
    ├─ rawFinishReason      → 保留原始语义
    └─ tokenUsage           → 最终 usage
    ↓
构造 completeMessage
    ↓
如已完成，则解析 ParsedToolCall[]
    ↓
yield StreamingResponse
```

### 流程 4：中断处理

```text
provider stream 在迭代过程中抛错
    ↓
provider.isAbortError(error) === true
    ↓
llm-client 捕获并构造最后一条部分结果
    ├─ isComplete = true
    ├─ finishReason = 'length'
    └─ completeMessage = 当前已累积内容
    ↓
yield 最后一条 StreamingResponse
```

## 接口定义

### createLLMClient()

```typescript
async function createLLMClient(): Promise<LLMClientInstance>
```

### streamChatCompletion()

```typescript
async function* streamChatCompletion(
  llmClient: LLMClientInstance,
  messages: ChatCompletionMessageParam[],
  options?: {
    signal?: AbortSignal;
    tools?: ChatCompletionCreateParams['tools'];
  }
): AsyncGenerator<StreamingResponse, void, unknown>
```

行为保证：

- 每次 yield 都携带当前完整的 `completeMessage`
- 工具调用参数只在完成态解析
- 中断时返回部分结果，不丢弃已生成内容
- 如 provider 有额外完成语义，可通过 `rawFinishReason` 透出

## 数据归属与责任

| 数据 | 创建者 | 消费者 | 责任边界 |
|------|--------|--------|---------|
| `LLMConfig` | config/llm | llm-client | llm-client 仅读取 |
| `ProviderInstance` | services/providers | llm-client / 上层 | llm-client 持有，不改写 |
| `ProviderRequest` | llm-client | provider | 单次调用参数 |
| `ProviderStreamEvent` | provider | llm-client | 唯一流式输入 |
| `StreamingResponse` | llm-client | 上层消费者 | 完整消息和完成态输出 |
