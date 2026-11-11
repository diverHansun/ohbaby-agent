# llm-client 数据模型

源码现位于独立公开包 `ohbaby-llm`。完整类型定义以 `packages/ohbaby-llm/src/client/types.ts` 及 `packages/ohbaby-llm/src/providers/types.ts` 为准。

## 请求与工具

共享边界使用自有 `ModelMessage`、`ModelToolDefinition`，不以 OpenAI Chat SDK 类型充当内部消息模型。Chat、Responses、Anthropic adapter 各自生成 wire 数据。assistant 可携带经校验的 `modelState`，协议特殊状态仍由对应 adapter 处理。

- `LLMClientInstance`：provider 实例和不含明文密钥的模型配置；SDK client 位于 provider.client。
- `ToolCallSnapshot`：index、callId、name、argumentsJson，表示尚在累积的调用。内部 accumulator 也使用 callId/name/argumentsJson。
- `ParsedToolCall`：callId、name、arguments，表示耗尽后解析完成的调用；不单独授权执行。
- snapshot 按 index 排序；parsed calls 保持既有首次出现顺序。

## StreamingResponse

| 字段                               | 含义                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| messageSnapshot                    | 已累积正文和工具片段，供展示；不是可直接持久化/发送的完整协议消息                        |
| reasoningText / reasoningTextDelta | 已累积推理及本次增量，按现有原生状态策略处理                                             |
| isComplete                         | 此次尝试的最后一份快照；正常终态和本地取消最终快照均可能为 true，一次尝试至多一次        |
| finishReason                       | provider 终态：stop、tool_calls、length、content_filter；本地取消/无终态 EOF 不伪造 stop |
| streamStopReason                   | provider_finished 或 user_aborted；后者必须有真实本地取消依据                            |
| parsedToolCalls                    | 正常耗尽并解析后的完整调用；length/filter/abort 不发布可执行参数                         |
| modelState                         | 正常耗尽且原生投影校验后的续接状态；失败/截断/过滤不接受                                 |
| tokenUsage                         | provider 已报告用量，可缺失；有数值不自动代表步骤可信                                    |
| retry                              | 项目层重试信息，不包含上层 overflow 或摘要恢复预算                                       |

中间帧 isComplete=false。仅有正文、usage 或 reasoning 但没有终态的 EOF 是中断；空流也不能生成完成。显式 stop 且正文为空是合法终态，与空流不同。

## 完成与运行结果

Lifecycle 等生成器耗尽之后再发布一次 `llm:complete`。length/filter 可有可靠模型完成，但运行失败；模型完成后数据库保存失败，也不能变成运行成功。

接受前取消：不发模型完成、不通知可信 Step 用量、不校准。已观测数字只进入 Run 部分汇总，usageComplete=false，不保留完整 inputBreakdown。接受后取消保留已经接受的用量。

## 中断与重试

`ProviderStreamInterruptedError.source` 可为 transport、eof、protocol、provider_abort；不明来源保留 undefined。来源用于区分事实，不能据包装类名把所有异常都当网络断流。provider 自报 abort 但本地 signal 没取消属于失败。

三个内置 adapter 均设置 SDK `maxRetries: 0`，没有 SDK 隐藏重试。项目默认额外重试 5 次，在一个不含 overflow 或摘要恢复的步骤请求通道最多 6 次 HTTP 尝试；这不是 Run 总预算。正文、推理、工具片段或完成信号出现后项目层不重发，不新增自动续写。摘要 transport 恢复和 context overflow 强制压缩恢复仍由 agent 上层管理。

模型窗口、缓存用量、reasoning/native 状态沿用前序合同；此处不定义新的计量或缓存控制算法。

## 可选用量明细（2026-10-13，compact improve-1）

`TokenUsage`／`StreamingTokenUsage` 增加可选 `reasoningTokens`，是 `outputTokens` 子项，不重复计入 `totalTokens = inputTokens + outputTokens`。缺失、非法或大于 output 的明细保持未知，明确的 0 保留；任一请求明细缺失时，Run 聚合明细也未知。cache breakdown 仍属于 inclusive input。

请求记录的 `usage?: TokenUsage` 是可选字段，旧记录可读且不补零。普通请求与摘要请求的记录类型由 agent 定义，见下节；包只提供观测回调，具体持久化与事务提交归 agent 管理。

## 请求尝试观测（2026-10-21，llm 包去 agent 概念）

包只描述一次请求尝试本身，类型是 `ModelRequestAttempt`，字段为 `requestId`、`attempt`、`startedAt`、`firstTextAt?`、`endedAt?`、`usage?`、`retryScheduled?: true` 和 `outcome`。`ModelRequestObservation` 携带这个类型，不再带 run、step 或 compaction 字段。

调用方传入 `beforeRequestAttempt` 或 `onRequestObservation` 时，包才会记录尝试。观测会被等待保存，并在流里以 `requestObservation` 原样产出。

归属字段由 agent 自己补。`AgentStepRequestRecord`、`SummaryRequestRecord` 和 `ModelRequestRecord` 定义在 agent 的 `core/message/types.ts`：

- lifecycle 在回调里补 `runId`、`messageId`、`step` 和 `purpose: "agent-step"`；
- 摘要请求只保留 `request-ended`，补 `compactionId`、摘要 `messageId`、压缩层的 `attempt`、`inputIds` 和 `purpose: "context-summary"`。

沿用原有 JSON 存储，不新增表或 SQL 列。

`retryScheduled` 是失败 attempt 首次结束时已决定安排重试的历史事实。它与 `endedAt/outcome` 一起保存，不能事后补写；不证明下一次请求已发生。取消先封口时不带这个字段；安排后取消保留历史，但不再发送。保存失败仍以 `ModelObservationError` 阻断，诊断失败不影响模型结果。

`ModelRequestObservation.failure?` 只携带当次失败的安全诊断：有限类别、状态码、筛选后的上游 code/type、网络错误码和本次退避时间。它不属于 `ModelRequestAttempt`，不进入消息 JSON 或模型输入。agent 在既有日志中以稳定指纹关联请求、run、消息、会话和模型。

`providerErrorDetail` 是 core 和 runtime 共用的安全原因提取入口。它保留重试耗尽/流中断包装下的原因，只生成固定说明；未知上游正文不透传。已识别的 Chat＋工具＋推理协议限制提示切换 Responses，认证、余额、限流和连接错误分别说明。`retryable` 沿用重试资格语义，不授权部分输出重放。

未知的终态 provider 异常用 `ProviderRequestError` 标记边界，原异常保留为直接 `cause`，既有 prompt-cache 策略标记继续保留。公开说明只经过安全提取；取消、观测保存失败、本地请求校验、工具参数解析和 context overflow 不转成这种通用错误。

运行时映射优先保留 `ModelObservationError` 与 `ToolDeliveryError` 的内部归属；其 cause 即使带 HTTP 状态或网络码，也不据此标为模型服务失败。沿用 `RUNTIME_ERROR` 与原 terminalReason，不改变真实 provider 错误的分类。

适配器本地请求校验使用 `ModelRequestValidationError`，保留可诊断的本地说明，归 runtime 且不重试。响应流中的上游未知错误仍走安全 provider 包装。保存失败终态的公开文字使用 lifecycle 摘要，与 run 状态一致。

诊断收窄：不读取或保留供应商请求编号；关联依赖本地 request/run/session。错误分类仅有总兜底，已识别 provider 的畸形字段可降级为固定通用提示，不再逐字段补救；正常错误分类和前端契约不变。
