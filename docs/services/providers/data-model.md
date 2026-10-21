# providers 模块的数据模型

源码定义以 `packages/ohbaby-llm/src/providers/types.ts`、`native-state.ts` 和 `reasoning.ts` 为准，公开符号通过 `ohbaby-llm` 导入。

## 配置与实例

- `InterfaceProviderKind`：`openai-compatible | openai-responses | anthropic`，唯一类型定义在同包 `src/config/types.ts`，providers 再导出。
- `CreateInterfaceProviderOptions`：`id`、可选 `interfaceProvider`、`apiKey`、`baseUrl` 和可选 `tokenUsageReporter`。只绑定连接，不绑定请求模型。
- `InterfaceProviderInstance`：`id`、`kind`、SDK `client`、`streamResponse(request)`、`isAbortError(error)` 和可选 `streamStart`。

## 消息与请求

`ModelMessage` 为自有消息联合类型，包含 system、developer、user、assistant、tool。assistant 可携带 `toolCalls`、推理和经校验的 `modelState`；tool 使用 `callId` 关联调用。不同协议对内容类型的支持以各 adapter 校验为准。

`ModelToolDefinition` 使用 `name`、可选 `description` 和 `inputSchema`；`ModelToolCall` 使用 `callId`、`name` 和原始 `argumentsJson`。共享层不复用 OpenAI SDK 消息或工具类型。

`InterfaceProviderRequest` 包含 model、messages、maxTokens、promptCache，以及可选 temperature、reasoning、tools、signal、onActivity、purpose、sessionId、contextScopeId。`onActivity` 必须同步、轻量且不抛异常。

## 规范化事件

`InterfaceProviderStreamEvent` 的字段均为可选：

| 字段                               | 含义                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `textDelta` / `reasoningTextDelta` | 正文和推理的独立增量                                       |
| `toolCallDeltas`                   | 按 index 累积的 id、name、argumentsDelta；不提前解析 JSON  |
| `finishReason` / `rawFinishReason` | 共享终态与厂商原始停止值                                   |
| `tokenUsage` / `reasoningTokens`   | 规范化用量及原生输出的推理 token 信息                      |
| `nativeOutput`                     | 当前协议支持的原生输出，交由 client 在耗尽后校验并构造状态 |

共享 `InterfaceProviderFinishReason` 为 `stop | tool_calls | length | content_filter`。例如 Chat `function_call` 映射为 `tool_calls`；Anthropic `end_turn`、`stop_sequence`、`pause_turn` 映射为 `stop`，`tool_use` 映射为 `tool_calls`，`max_tokens` 映射为 `length`；原始值另行保留。

## 用量与缓存

`InterfaceProviderTokenUsage` 使用 `inputTokens`、`outputTokens` 和 `totalTokens = inputTokens + outputTokens`。input 包含缓存部分；可选 `inputBreakdown` 区分 uncached/cacheRead/cacheWrite，并记录字段是否被观测。可选 `reasoningTokens` 是 output 的子项，不重复计入 total；缺失与明确的 0 不等价。

`InterfaceProviderPromptCache` 是按 strategy 区分的联合类型，包括 observe-only、OpenAI keyed implicit 和两种 Anthropic 策略。策略由 client 解析，adapter 只发对应控制字段；Responses 维持 observe-only。

## 原生状态与最终完成

`NativeOutput` 按协议区分；`ModelState` 记录来源和可重放状态。原生状态只能在同源及投影校验通过时使用，不代表任意厂商 output 都有共享表达。

provider 不返回最终 `StreamingResponse`。client 必须等待流耗尽，校验终态、工具参数及 native 投影；上层不能仅凭一个 provider 终态事件执行工具或持久化成功。
