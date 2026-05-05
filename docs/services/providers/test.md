# providers 模块的测试策略

## 测试目标

验证 provider 层的两类职责：

1. 是否把统一请求参数正确转换为厂商原生请求
2. 是否把厂商原生流事件正确归一为 `ProviderStreamEvent`

## 当前测试范围

### OpenAI-compatible provider

当前测试文件：`packages/ohbaby-agent/src/services/providers/openai-compatible.test.ts`

覆盖点：

- 请求参数构造：`model`、`messages`、`temperature`、`max_tokens`
- `stream_options: { include_usage: true }` 是否附带
- tools 是否透传
- `function_call` 是否归一为 `tool_calls`
- `rawFinishReason` 是否保留原始值

### Anthropic provider

当前测试文件：`packages/ohbaby-agent/src/services/providers/anthropic.test.ts`

覆盖点：

- OpenAI-compatible messages → Anthropic Messages 请求转换
- assistant `tool_calls` → `tool_use` block 转换
- tool message → `tool_result` block 转换
- `content_block_delta` / `message_delta` 的归一化
- `pause_turn` 是否通过 `rawFinishReason` 保留
- 默认不依赖 `eager_input_streaming`

## 建议继续补充的场景

1. **Anthropic 非法 tool arguments**
   - assistant 历史消息里的 `tool_calls[*].function.arguments` 不是合法 JSON 时应抛出明确错误

2. **OpenAI-compatible 空 keepalive chunk**
   - 确认空 `tool_calls` / 空 `choices` 不会产生多余事件

3. **非中断错误传播**
   - `streamChatCompletion()` 出现普通 API 错误时，不应被误判为 abort

4. **未知 provider id 的行为**
   - 当前实现默认走 OpenAI-compatible provider，建议补测试固定这个行为

## 测试边界原则

- provider 单测只验证“协议转换”和“事件归一化”
- `completeMessage` 累积、`ParsedToolCall[]` 解析、中断后部分结果返回，属于 `core/llm-client` 的职责