# providers 模块的数据流与接口设计

## 上下文与范围

当前 providers 模块位于 `core/llm-client` 与厂商 SDK 之间：

- `config/llm` 提供连接级配置
- `core/llm-client` 调用 `createProvider()` 并向 provider 发起流式请求
- provider 内部对接 `openai` SDK 或 `@anthropic-ai/sdk`

本文档描述当前已实现的接口和数据流。

## 数据流描述

### 流程 1：provider 创建

```text
core/llm-client.createLLMClient()
    ↓
createProvider({ provider, apiKey, baseUrl })
    ↓
resolveProviderKind(provider)
    ├─ anthropic / claude → createAnthropicProvider()
    └─ 其他值 → createOpenAICompatibleProvider()
    ↓
返回 ProviderInstance
```

### 流程 2：发起流式请求

```text
core/llm-client.streamChatCompletion()
    ↓
构造 ProviderRequest
    ├─ model
    ├─ messages
    ├─ temperature
    ├─ maxTokens
    ├─ tools?
    └─ signal?
    ↓
provider.streamChatCompletion(request)
```

### 流程 3：provider 内部处理

#### OpenAI-compatible

```text
ProviderRequest
    ↓
buildRequestParams()
    ↓
client.chat.completions.create(..., { signal })
    ↓
逐 chunk 归一化为 ProviderStreamEvent
```

#### Anthropic

```text
ProviderRequest
    ↓
convertMessages() / convertTools()
    ↓
client.messages.stream(..., { signal })
    ↓
逐 SSE event 归一化为 ProviderStreamEvent
```

### 流程 4：归一化事件输出

provider 向上游输出：

```typescript
interface ProviderStreamEvent {
  textDelta?: string;
  toolCallDeltas?: ProviderToolCallDelta[];
  finishReason?: ProviderFinishReason;
  rawFinishReason?: string;
  tokenUsage?: ProviderTokenUsage;
}
```

其中：

- `textDelta`：文本增量
- `toolCallDeltas`：工具调用 id / name / argumentsDelta 分片
- `finishReason`：共享枚举
- `rawFinishReason`：厂商原始值，例如 `function_call`、`pause_turn`
- `tokenUsage`：统一的精确 usage

## 接口定义

### 接口 1：createProvider()

```typescript
function createProvider(options: CreateProviderOptions): ProviderInstance
```

特性：

- 同步
- 只绑定连接级配置
- 不缓存实例

### 接口 2：ProviderInstance.streamChatCompletion()

```typescript
streamChatCompletion(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamEvent>>
```

特性：

- provider 对请求构造和原生事件归一化负责到底
- `core/llm-client` 不需要接触厂商原生 chunk 结构

### 接口 3：ProviderInstance.isAbortError()

```typescript
isAbortError(error: unknown): boolean
```

特性：

- 用于让 `core/llm-client` 在不感知 SDK 类型的情况下处理“返回部分结果”的中断分支

## 数据归属

| 数据 | 创建者 | 消费者 | 责任边界 |
|------|--------|--------|---------|
| `CreateProviderOptions` | `core/llm-client` | providers | 仅用于创建 provider |
| `ProviderRequest` | `core/llm-client` | providers | 单次调用参数，不缓存 |
| 原生 SDK stream | provider | provider 内部 | 不向上暴露 |
| `ProviderStreamEvent` | provider | `core/llm-client` | 归一化后的唯一流式边界 |
| `rawFinishReason` | provider | 上层消费者 | 用于保留厂商特有语义 |

## 当前不做的事

- 不对外暴露 `buildRequest()`、`normalizeChunk()` 等分离式 adapter 方法
- 不在 providers 内累积完整消息或解析最终 `ParsedToolCall[]`
- 不在 providers 内做 retry、fallback、tool execution