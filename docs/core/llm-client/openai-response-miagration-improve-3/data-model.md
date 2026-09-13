# llm-client 模块的数据模型

## 请求与结果分开

| 类型 | 含义 |
| --- | --- |
| `ModelMessage` | 自有、按 role 区分的有序请求消息；不是数据库 Message |
| `ModelToolDefinition` | `{name, description?, inputSchema}`，不含固定 function 外壳 |
| `ModelToolCall` | `{callId, name, argumentsJson}`，完整调用描述；参数文本尚不代表可执行 |
| `ParsedToolCall` | `{callId, name, arguments}`，JSON 已解析，仍须经过工具执行检查 |
| `ModelResponseSnapshot` | 当前累计输出，可包含未完成的工具参数片段 |
| `StreamingResponse` | 快照及本次流的状态、usage、reasoning、重试信息 |

请求值类型由 ohbaby 定义，不是 SDK alias。system 保留在消息序列中；assistant 的 `toolCalls` 与 tool 消息的 `callId` 配对。raw `argumentsJson` 不因字段改名重新 JSON.stringify。完整角色/内容闭集、少量沿用原名的多模态字段及各 adapter 差异以 [批准字段合同](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/design/data-model.md) 为准。

旧 function 角色、assistant.function_call 和历史 custom 调用不再属于公共请求合同。Chat 的原生 `finish_reason=function_call` 兼容映射、Responses 的原生 function_call item 是另一件事，仍保留。

## 流快照

```ts
interface ToolCallSnapshot {
  readonly index: number;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsJson: string;
}
interface ModelResponseSnapshot {
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCallSnapshot[];
}
```

index 仅关联当前流中的片段，不是持久调用 ID，不进入请求或 SQLite。callId/name 可能尚未收齐；缺失与空值不自动修复。tool-only 快照的 content 为 null，普通文本为字符串。既有空完成占位 `(Empty response)`、空取消占位 `(Interrupted)` 保持不变。

`StreamingResponse.messageSnapshot` 必有，快照内没有 role 或 reasoning。累计 `reasoningText` 和增量 `reasoningTextDelta` 只在外层出现，都是纯文本，不是 native reasoning state。`parsedToolCalls` 只按既有完成与解析门输出；`isComplete` 本身不足以授权工具，取消也可为 true。

`finishReason?: ModelFinishReason` 的值仍为 `stop | tool_calls | length | content_filter`；`rawFinishReason` 保留供应商原值，`streamStopReason` 为 `provider_finished | user_aborted`。retry 帧保持既有 `retry` 信息。调用者应消费完整流，检查成功状态与调用完整性后，再显式构造下一轮 assistant/tool 请求，不能强转 partial snapshot。

LifecycleEvent 是另一层观察合同：其 `messageSnapshot` 允许缺失。wire complete 不包含正文，缺快照不是空回复，也不能用作新历史或工具授权。

## Usage 与持久化

`TokenUsage` / `StreamingTokenUsage` 只暴露 canonical `inputTokens`、`outputTokens`、`totalTokens` 和可选 `inputBreakdown`。inputTokens 含缓存输入；breakdown 的 uncached/cacheRead/cacheWrite 及 observed 含义不变，缺失不是零。

公开的 `prompt_tokens/completion_tokens/total_tokens` 别名已经移除。数据库中旧 `promptTokens/completionTokens` metadata 的读取兼容仍保留，不能混淆这两个删除边界。SQLite Message/Part JSON 及新写 canonical usage 均保持原格式。

## Client

`LLMClientInstance` 仍持有 provider 和不含密钥的 config。当前模型、端点、协议字段 `config.interfaceProvider`、默认 temperature/maxTokens、promptCache 以及既有窗口元数据从 config 读取；provider 自身的协议字段才是 `provider.kind`。密钥只用于 SDK 初始化。无需引入另一份公共 client/message 类型来包装它。
