# llm-client 模块的数据模型

## 核心概念

### LLMClientInstance（客户端实例）

llm-client 的核心对象，包含 OpenAI SDK 实例和相关配置。

```typescript
interface LLMClientInstance {
  client: OpenAI;           // OpenAI SDK 实例
  config: {
    model: string;          // 模型名称（如 'gpt-4'）
    temperature: number;    // 采样温度（0-2）
    maxTokens: number;      // 最大输出 token 数
  };
}
```

**设计说明：**
- config 是不可变的，在创建后不会改变
- client 可直接用于非流式 API 调用

### ChatCompletionMessage（聊天消息）

来自 OpenAI SDK，表示对话中的一条消息。支持多种角色：

```typescript
type ChatCompletionMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: string; tool_call_id: string }
```

**角色说明：**
- `user`：用户输入消息
- `assistant`：助手响应消息，可能包含 tool_calls
- `system`：系统级指令消息
- `tool`：工具执行结果消息

### ParsedToolCall（已解析的工具调用）

从流中完整积累并解析后的工具调用。

```typescript
interface ParsedToolCall {
  id: string;                           // 工具调用唯一 ID
  name: string;                         // 调用的工具/函数名称
  arguments: Record<string, unknown>;   // 解析后的 JSON 参数对象
}
```

**约束：**
- 仅在流完成且 finishReason === 'tool_calls' 时出现
- arguments 已通过 JSON.parse() 转换为对象
- 保证 JSON 有效（解析失败会抛异常）

### StreamingResponse（流式响应）

流式调用返回的单个响应块。每次迭代返回一个此对象。

```typescript
interface StreamingResponse {
  completeMessage: ChatCompletionMessage;     // 当前积累的完整消息
  parsedToolCalls?: ParsedToolCall[];         // 已解析的工具调用（仅流完成时）
  isComplete: boolean;                        // 流是否完成
  finishReason?: ChatFinishReason;            // 完成原因（仅流完成时）
  tokenUsage?: TokenUsage;                    // Token 统计（仅流完成时）
}
```

**completeMessage 的演变过程：**
1. 流开始时：空消息
2. 流进行中：逐步累积文本或 tool_calls
3. 流完成时：包含完整的最终内容和 tool_calls

**parsedToolCalls 的出现时机：**
- 仅当 isComplete === true 时才被填充
- 仅当 finishReason === 'tool_calls' 时才非空
- arguments 的 JSON 已完全解析

### ChatFinishReason（完成原因）

流式响应完成的原因。

```typescript
type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'
```

**各原因说明：**
- `'stop'`：模型自然停止或触发停止词
- `'tool_calls'`：模型决定调用工具
- `'length'`：达到 maxTokens 限制或用户中断
- `'content_filter'`：内容被过滤策略拦截

### TokenUsage（Token 使用统计）

来自 OpenAI API 的精确 Token 计数。

```typescript
interface TokenUsage {
  prompt_tokens: number;      // 提示词的 token 数
  completion_tokens: number;  // 生成内容的 token 数
  total_tokens: number;       // 总计 token 数
}
```

**可用时机：**
- 仅在流完成时提供（isComplete === true）
- 来自 API 的精确计数，不是估算值
- 用户中断时可能不可用

## 数据流向

### 流式调用的数据状态演变

```
开始流式调用
    ↓
[Chunk 1] content: "Hello"
  → completeMessage.content = "Hello"
  → isComplete = false
  ↓ yield StreamingResponse

[Chunk 2] content: " world"
  → completeMessage.content = "Hello world"
  → isComplete = false
  ↓ yield StreamingResponse

[Chunk 3] finish_reason: "stop", usage: {...}
  → completeMessage.content = "Hello world"
  → isComplete = true
  → finishReason = "stop"
  → tokenUsage = {...}
  ↓ yield StreamingResponse

[End of Stream]
```

### 工具调用的数据状态演变

```
开始流式调用（带 tools）
    ↓
[Chunk 1] tool_calls[0].function.arguments: "{\"name"
  → completeMessage.tool_calls[0].function.arguments = "{\"name"
  → parsedToolCalls = undefined（未完成）
  ↓ yield StreamingResponse

[Chunk 2] tool_calls[0].function.arguments: "\": \"value"
  → completeMessage.tool_calls[0].function.arguments = "{\"name\": \"value"
  → parsedToolCalls = undefined（未完成）
  ↓ yield StreamingResponse

[Chunk 3] tool_calls[0].function.arguments: "}"}, finish_reason: "tool_calls"
  → completeMessage.tool_calls[0].function.arguments = "{\"name\": \"value\"}"
  → isComplete = true
  → finishReason = "tool_calls"
  → parsedToolCalls = [{ id, name, arguments: { name: "value" } }]（已解析）
  ↓ yield StreamingResponse
```

## 设计约束

1. **completeMessage 逐步构建**
   - 不缓存中间状态，每次返回最新的完整消息
   - 上层可直接用于存储或显示

2. **parsedToolCalls 延迟解析**
   - 不在流进行中解析 arguments（防止不完整 JSON 错误）
   - 仅在流完成时一次性解析所有 tool calls

3. **TokenUsage 的完整性**
   - 仅在流正常完成时提供（用户中断时可能缺失）
   - 来自 OpenAI API 的精确值，不是估算

4. **isComplete 和 finishReason 的关系**
   - isComplete = true 当且仅当 finishReason !== null
   - finishReason 仅在 isComplete = true 时有意义
