# llm-client 模块的数据模型

## 核心类型

### LLMClientInstance

```typescript
interface LLMClientInstance<TClient = unknown> {
  provider: InterfaceProviderInstance<TClient>;
  config: {
    provider: string;
    model: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
  };
}
```

设计说明：

- 顶层不再重复暴露 `client`
- 如需直接访问 SDK，走 `llmClient.provider.client`
- `config` 只保留非敏感字段

### ChatCompletionMessage

```typescript
type ChatCompletionMessage = ChatCompletionMessageParam;
```

说明：

- 这仍是当前 llm-client 的输入/输出消息边界
- provider 层会把它映射到各厂商原生协议
- 即使选择 `openai-responses`，共享层也仍传递这个 Chat-shaped 边界；Responses adapter 仅接受可无损投影的子集，并拒绝需要原生 continuation 的 item。
- 这不是 canonical 跨协议消息模型。原生 reasoning/output-item、assistant `phase`、refusal 和 annotation 尚无共享表达。

### ParsedToolCall

```typescript
interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

### InterfaceProviderFunctionTool

```typescript
interface InterfaceProviderFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}
```

这是当前 agent 明确支持的工具请求边界。core 不直接依赖 OpenAI SDK 可继续扩展的 `ChatCompletionTool` 联合；各 provider adapter 负责把该结构映射到自己的 SDK 类型。

`openai-responses` 只投影本地 function tool；hosted/custom tools 以及其他 Responses output item 不在本轮能力范围内，必须 fail-closed。

### StreamingResponse

```typescript
interface StreamingResponse {
  completeMessage: ChatCompletionMessage;
  parsedToolCalls?: ParsedToolCall[];
  isComplete: boolean;
  finishReason?: ChatFinishReason;
  rawFinishReason?: string;
  tokenUsage?: TokenUsage;
}
```

字段说明：

| 字段 | 作用 |
|---|---|
| `completeMessage` | 当前已累积的完整消息 |
| `parsedToolCalls` | 仅在完成态出现的结构化工具调用 |
| `isComplete` | 是否已完成 |
| `finishReason` | 共享完成原因 |
| `rawFinishReason` | provider 原始完成原因 |
| `tokenUsage` | provider 归一化后的精确 usage |

### ChatFinishReason

```typescript
type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';
```

### TokenUsage

```typescript
type TokenUsage = InterfaceProviderTokenUsage;
```

说明：

- `TokenUsage` 现在来自 provider 层的统一类型
- llm-client 已不再直接依赖 OpenAI 的 `CompletionUsage`
- prompt cache 策略由 provider 边界决定。Responses 目前仅观察 usage，不发送 cache 控制字段，也不与 Chat keyed cache 语义对齐。

## 累积模型

### 文本流

`textDelta` 持续追加到 `accumulatedContent`，每次 yield 都构造新的 `completeMessage.content`。

### 工具调用流

`toolCallDeltas` 按 `index` 累积到 Map 中，等待完成态后统一解析 JSON arguments。

### 中断流

如果 provider 抛出中断错误：

- `completeMessage` 使用当前累积结果
- `isComplete = true`
- `streamStopReason = 'user_aborted'`
- 不伪造 provider `finishReason`
- `rawFinishReason` 保留中断前最后一次 provider 事件携带的原始值（如有）
