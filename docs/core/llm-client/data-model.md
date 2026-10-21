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

`ModelRequestRecord.usage?: TokenUsage` 是记录的可选字段，旧记录可读且不补零。普通请求与摘要请求分别使用 `AgentStepRequestRecord` 和 `SummaryRequestRecord`；请求记录回调由包提供，具体持久化与事务提交归 agent 管理。
