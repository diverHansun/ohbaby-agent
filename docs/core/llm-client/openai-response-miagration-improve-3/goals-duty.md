# llm-client 模块的目标与职责

## 当前定位

`core/llm-client` 负责绑定模型配置、发起流式请求、处理安全重试和累积结果。公开入口是 `createLLMClient()` 与 `streamResponse()`；请求使用 ohbaby 自有的 `ModelMessage` 和 `ModelToolDefinition`，不再借用 Chat SDK 请求类型。

每个供应商协议仍有自己的 adapter。未指定 kind 时仍为 `openai-compatible`；`openai-responses` 与 `anthropic` 必须显式选择，不根据 URL 自动切换，也不在失败后回落其他协议。

## 职责

1. 从 `config/llm` 读取连接信息及模型默认参数，通过 provider factory 创建实例；公开 config 不包含 API key。
2. 把有序消息、工具和本次调用选项交给 provider。system 仍在共享消息序列中，具体出站转换属于 adapter。
3. 累积文本、纯文本 reasoning 和工具参数片段，持续产生 `StreamingResponse`。正文唯一累计快照为 `messageSnapshot`；它不是存储消息或可直接回发的请求。
4. 按既有完成信号解析工具参数；保留规范化结束原因、原始结束原因、流停止原因及 provider usage。
5. 仅在尚未输出内容/推理/工具片段或结束信号时，对可重试故障做有限重试；已输出后的错误不自动重放请求。取消返回部分快照，不提供可执行的 parsed calls。

## 明确不负责

- 不解析供应商原生 HTTP/SSE 事件：由 `services/interface-providers` 负责。
- 不执行工具、判断权限或调度工具批次：`parsedToolCalls` 不是执行授权，仍须经过 lifecycle/scheduler 的既有检查。
- 不保存 session/message/run，不改 Message/Part JSON 或数据库 schema。
- 不决定估算材料、token 算法、窗口预算和压缩策略。返回的 usage 是请求后的供应商观测值，与发送前启发式估算分开。
- 不维护 cache 命中统计，不因命中缓存减少 context 占用。
- 不提供非流式新入口、跨协议 fallback、Responses 原生状态续接或默认协议切换。

## 当前 Responses 能力边界

Responses adapter 只接收能够无损投影的受限文本和本地函数工具请求，使用完整 replay、`store: false`，不使用 `previous_response_id`。cache 仅观察 usage，不发送控制字段。原生 reasoning/phase、签名/加密状态、refusal/annotation、hosted/custom tools 等不在当前输出合同中，保持拒绝边界。

`reasoningText` 只是明文思考文本，不代表可以保存并重放供应商原生状态。共享输入支持的少量 Chat 内容字段也不等于三个 adapter 都支持它们。

接口迁移与后续边界见 [improve-3 数据合同](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/design/data-model.md) 和 [后续计量规划](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/next-stage-candidates.md)。
