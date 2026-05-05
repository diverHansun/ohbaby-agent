# providers 模块的数据模型

## 核心类型

### ProviderKind

```typescript
type ProviderKind = 'openai-compatible' | 'anthropic';
```

当前是 provider 内部实现分类，不等同于用户配置里的原始 `provider` 字符串。

### CreateProviderOptions

```typescript
interface CreateProviderOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
}
```

说明：

- 这是连接级配置，不包含 `model`、`temperature`、`maxTokens`
- 这样 provider 可以被复用到不同模型调用上

### ProviderRequest

```typescript
interface ProviderRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
  tools?: ChatCompletionCreateParams['tools'];
  signal?: AbortSignal;
}
```

说明：

- 当前 provider 层仍以 OpenAI-compatible message/tool 类型作为统一输入边界
- Anthropic provider 会在内部把这些输入转成 Messages API 形态

### ProviderTokenUsage

```typescript
interface ProviderTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

这是 provider 层统一后的 usage 形状，`core/llm-client` 已直接复用它，不再依赖 OpenAI 的 `CompletionUsage`。

### ProviderToolCallDelta

```typescript
interface ProviderToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}
```

说明：

- `index` 用于跨 chunk 累积同一个工具调用
- `argumentsDelta` 始终是原始 JSON 片段，不在 provider 内提前解析

### ProviderStreamEvent

```typescript
interface ProviderStreamEvent {
  textDelta?: string;
  toolCallDeltas?: ProviderToolCallDelta[];
  finishReason?: ProviderFinishReason;
  rawFinishReason?: string;
  tokenUsage?: ProviderTokenUsage;
}
```

设计说明：

- 这是 provider 对上游暴露的唯一流式事件模型
- `rawFinishReason` 用于保留厂商特有语义，例如：
  - OpenAI-compatible: `function_call`
  - Anthropic: `pause_turn`

### ProviderInstance

```typescript
interface ProviderInstance<TClient = any> {
  id: string;
  kind: ProviderKind;
  client: TClient;
  streamChatCompletion(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

设计说明：

- 当前 `ProviderInstance` 已经吸收了早期文档中的 adapter 三件套职责
- `client` 只在 provider 内部和少数调试/测试场景需要直接访问
- 对 `core/llm-client` 来说，真正稳定的边界是 `streamChatCompletion()` 和 `isAbortError()`

## 共享完成原因模型

```typescript
type ProviderFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';
```

当前映射策略：

| 厂商原始值 | 共享值 | 备注 |
|---|---|---|
| `stop` | `stop` | OpenAI-compatible |
| `function_call` | `tool_calls` | OpenAI 旧值，raw 保留 |
| `tool_calls` | `tool_calls` | OpenAI-compatible |
| `end_turn` | `stop` | Anthropic |
| `stop_sequence` | `stop` | Anthropic |
| `pause_turn` | `stop` | Anthropic，raw 保留 |
| `tool_use` | `tool_calls` | Anthropic |
| `max_tokens` | `length` | Anthropic |

## 当前模型边界

1. **provider 输入边界仍复用 OpenAI-compatible message/tool 类型**
   - 这是当前实现的简化点
   - 未来若需要完全摆脱 OpenAI SDK 类型，再引入独立消息模型

2. **provider 不返回最终完成态对象**
   - 不存在 `CompletedResponse`
   - 最终完成态由 `core/llm-client` 在累积 normalized event 后构建