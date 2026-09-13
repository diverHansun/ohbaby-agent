# llm-client 数据流与接口

## 创建与发送

`createLLMClient(options?)` 接受现有 `projectDirectory`、`modelJsonPath`、`envPath`、`env`、`logger` 选项，读取配置并通过 provider factory 返回 `LLMClientInstance`。默认 envPath 跟随当前 projectDirectory；公开 config 不返回 API key。

```ts
streamResponse(llmClient, messages, options?)
// messages: readonly ModelMessage[]
// options: retry?, signal?, tools?, maxTokens?, purpose?,
//          sessionId?, contextScopeId?
// 返回 AsyncGenerator<StreamingResponse, void, unknown>
```

tools 使用 readonly ModelToolDefinition[]。单次 maxTokens 覆盖不修改共享 config。purpose/sessionId/contextScopeId 按原有规则交付 provider，保持主子代理、summary/title 和 cache 归属隔离。

调用顺序是：构造 InterfaceProviderRequest → provider.streamResponse → 消费归一化事件 → 累积 messageSnapshot/reasoningText → 按完成信号解析工具参数 → yield StreamingResponse。provider 自己处理 SDK 原生 snake_case 字段和各协议事件，不向 context/lifecycle 暴露 Chat SDK 消息类型。

## 成功、取消与错误

- 文本或工具 delta 更新当前 snapshot；raw 工具参数先累积，未完成片段不解析执行。
- 正常完成携带已有结束原因、usage 和可能的 parsedToolCalls。调用者消费完整流并经过既有成功/权限/schema 门后才执行工具。
- 用户取消返回最后的 snapshot、`isComplete=true` 和 `streamStopReason=user_aborted`，不伪造成功 finishReason，不返回 parsed 工具调用。
- 可重试且尚无可见输出的故障会产生 retry 通知并有限重试；每次尝试独立累积。输出后故障不自动重放；具体错误类型见 architecture.md。
- Responses 必须校验其受限原生事件序列及终态，不能因为中途见到完成消息就绕过后续错误/EOF 检查。

## 下游投影

| 边界 | 规则 |
| --- | --- |
| lifecycle → Message/Part | 保留原存储字段与 usage 放置规则；不写 snapshot/index 新结构 |
| 下一步 context serializer | 从已有持久消息/工具结果生成新的 ModelMessage |
| 直接公开调用者的多轮请求 | 检查成功与完整调用，显式加 role、去局部 index、保留 argumentsJson |
| lifecycle → worker → UI wire | 既有 DTO 不变，不为快照增加传输字段 |
| wire → 观察 LifecycleEvent | delta 从 content 构造文本 snapshot；complete 没有正文则省略 snapshot |

## 兼容范围

旧 streamChatCompletion/toOpenAiTools 入口和 Chat-shaped 公共消息/工具类型不保留别名；新入口为 streamResponse/toModelTools。这是公共源码调用接口迁移，不是数据库迁移。字段对应表见 [improve-3 数据合同](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/design/data-model.md)。

默认协议、cache 策略、token 启发式和压缩阈值不变。Responses 保持 store=false 的受限 replay，不包含原生状态续接能力；完整迁移与默认翻转仍是后续工作。
