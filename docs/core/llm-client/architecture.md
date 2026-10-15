# llm-client 模块架构设计

## 当前状态

`core/llm-client` 是配置绑定的 provider-aware 流式执行层。它位于 `config/llm`、`services/interface-providers` 与上层 lifecycle/message/runtime 之间。

公开职责：

- `createLLMClient()`：读取 `config/llm`，调用 `services/interface-providers.createInterfaceProvider()` 创建 provider 实例，并保留当前模型配置。
- `streamChatCompletion()`：构造 `InterfaceProviderRequest`，调用 provider，消费归一化的 `InterfaceProviderStreamEvent`，累积流式文本与 tool call 参数，生成 `StreamingResponse`。

```text
config/llm
  -> core/llm-client.createLLMClient()
  -> services/interface-providers.createInterfaceProvider()

upper runtime/lifecycle
  -> core/llm-client.streamChatCompletion()
  -> provider.streamChatCompletion()
  -> normalized InterfaceProviderStreamEvent
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
interface InterfaceProviderInstance<TClient = unknown> {
  id: string;
  kind: "openai-compatible" | "openai-responses" | "anthropic";
  client: TClient;
  streamChatCompletion(
    request: InterfaceProviderRequest,
  ): Promise<AsyncIterable<InterfaceProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
```

llm-client 不知道 provider 内部如何调用 SDK，只消费归一化事件。

当前的 kind 选择与能力边界：

- `openai-compatible` 仍是缺省，使用 Chat Completions；`anthropic` 仍须显式选择。
- `openai-responses` 是第三个、仅手工配置后才会启用的 kind；factory 必须显式分支，未知 kind 不得回落到 Chat。
- core 输入消息仍是 Chat-shaped `ChatCompletionMessageParam`。Responses adapter 在 provider 边界投影它；这不是内部 canonical message 协议。
- Responses 本轮为无状态完整 replay（`store: false`，不传 `previous_response_id`），并且 prompt cache 只 observe usage，不发送 Responses cache 控制字段；它尚未与 Chat cache 对齐。
- 原生 reasoning/output-item continuation、assistant `phase`、refusal、annotation、hosted/custom tools 不在这个共享接口中表达，adapter 必须 fail-closed。lifecycle、context 和持久化没有因该 kind 改造。

## 与 llm-model 的关系

`services/llm-model` 只提供模型元数据、token 估算和上下文限制。llm-client 不调用其 token 估算逻辑，也不把 provider 返回的真实 `TokenUsage` 和估算值混用。

命名边界：

- `core/llm-client.ChatCompletionMessage`：provider/lifecycle 输入消息边界。
- `services/llm-model.TokenCountMessage`：token 估算输入结构。

两个类型不应混名，也不应互相承担对方职责。

## 设计取舍

1. 当前消息输入继续沿用 Chat-shaped `ChatCompletionMessageParam`，降低共享层改动；Responses adapter 将其投影为 wire 请求，但本轮不将它 canonical 化。
2. provider 创建只绑定连接级配置，model/temperature/maxTokens 在请求时传入。
3. tool call 参数只在完成态解析，避免流式片段中间态误解析。
4. abort 判断委托给 provider，partial response 构造保留在 llm-client。

## 请求空闲看门狗（2026-10-15）

`streamResponse` 的每次 attempt 拥有一个 `idle-watchdog.ts` 实例。它分别守卫建流、首个 next、usage-only 后 next 和主循环 next；只计算未完成的 provider 等待，不计本地 flush 或消费者 yield 时间。默认 600,000 ms；请求级 `idleTimeoutMs` 可覆盖，必须为正有限数且不超过 2,147,483,647。没有环境变量、model.json 或 UI 配置入口。

provider 接收融合的 `providerSignal` 和可选 `onActivity`。三种协议在 SDK 原始事件到达时调用活动回调；没有产出归一化事件的 role/空 delta/状态事件也可续时。SDK 未暴露的心跳不在保证内。

超时只 abort 专属子 controller，并由 race 主动结束等待；不修改 caller signal。用户取消优先；无 partial 时走既有有界 retry，原因是 `stream_idle_timeout`，耗尽后抛 `ProviderRetryExhaustedError`；已有正文、reasoning、工具片段或 finish 时抛 `ProviderStreamInterruptedError`，不重放，也不把超时伪装成摘要可恢复的 transport 错误。

这个分类有一个上层后果：partial idle 在 lifecycle 中记录为 `APIError`，已输出正文仍保存在消息记录和 UI 中，但没有 interruption fact，也不会进入后续请求或摘要的失败历史投影。它与 ECONNRESET 的保留策略不同，属于本批按既有分类落地的边界。

安装的 OpenAI、Anthropic SDK 另有默认 600,000 ms 的建流 timeout，收到 HTTP 响应后清除；因此建流阶段存在同阈值竞争，错误可能先由 SDK 或看门狗报告。流读取仍由本模块守卫。未来上调 idle 常量时，需同时复查 SDK 的建流 timeout，不能将常量误当成唯一请求时限。

observer 观察受守卫的原始读取，迟到 chunk 不触发 first-text 记录。原始 opening 的回调保留局部 iterator 清理，先检查 aborted/finalized/expired 再绑定 attempt，覆盖退避期间 finally 尚未执行的窗口。return 继续 detach；不等待不合作 provider 的清理。

看门狗保护普通请求与 goal 请求，不判断任务进展；目录位置取舍及用户要求回看的事项见 [位置记录](../../problem-lists/2026-10-13-goals-upgrade/improve-1/06-request-idle-placement-review.md)。
