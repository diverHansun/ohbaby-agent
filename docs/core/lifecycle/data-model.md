# Lifecycle 数据模型

完整字段以 `packages/ohbaby-agent/src/core/lifecycle/types.ts` 为准。以下解释主要数据边界，不复制另一份容易漂移的完整类型定义。

## Step、Run 与历史

一个 Step 包括一次有效模型请求及其要求执行的工具；无有效输出的内部重试不是新的可信 Step。一个 Run 可包含多个 Step。每个模型步骤有独立 assistant 持久记录，后一步失败不能抹去前一步工具事实。

请求材料使用自有 ModelMessage/ModelToolDefinition。PreparedTurn 持有冻结请求、sentHeuristic、Context usage 和压缩信息；Lifecycle 不另建 Chat 形状历史。

## 事件

| 事件                                        | 含义                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| turn:start / turn:end                       | 步骤开始及结束事实，包含当前上下文信息                                 |
| llm:start                                   | 开始模型交互                                                           |
| llm:delta / reasoning-delta / reasoning-end | 流式展示；不能作为接受或工具执行凭证                                   |
| llm:retrying                                | 项目层重试，attempt 不等于所有 HTTP 尝试                               |
| llm:complete                                | provider 终态可靠且生成器耗尽后的一次模型完成；不代表持久化或 Run 成功 |
| tool:start / tool:result                    | callId 对应的执行与成功、业务错误或取消结果                            |
| step:complete                               | 工具处理后的步骤进度，不替代最终运行状态                               |

## LifecycleResult

- success：本次循环是否成功结束。
- finishReason：模型完成原因或本地 error；不能用它单独推断运行成功。
- terminalReason：completed、cancelled、output_length、content_filter、context_overflow、provider_stream_interrupted、provider_retry_exhausted、tool_parse_failure、model_state_persistence_failure 及既有 max-steps 原因。
- finalResponse、toolCalls：本次可报告的答复和调用事实。
- failureCause：需要向运行层说明的原始失败，不能通过它丢掉已接受 usage。
- usage：Run 汇总，包含 usageComplete 及可选 inputBreakdown。

RunWorker 继续使用既有 succeeded/failed/cancelled 状态，不新增并行 incomplete 状态机。输出截断/过滤属于 failed，已有内容仍保存供查看。

## 用量

可靠终态接受后，onStepUsage 与校准每步调用一次。模型完成后保存失败仍保留该可信用量。

接受前取消：已观测数字只进入部分 Run 汇总，usageComplete=false，不带完整 inputBreakdown，不进入可信 Step/cache 账本。此前已接受步骤保留。无终态、未知用量不能补零冒充完整。

工具结果和模型请求统计是不同层：普通工具失败可以继续 Agent，不应删除模型请求已有的可信用量。

## 失败消息分类

已耗尽的 `length` / `content_filter` 分别保存 `MessageOutputLengthError` / `MessageContentFilterError`。`ProviderStreamInterruptedError.source` 为 `transport` / `eof` 才保存 `MessageStreamInterruptedError`；协议校验、provider 自报 abort 或未知来源仍保守处理。本地取消使用已有 `MessageAbortedError`。

没有可用正文时的事实载体仍是既有 TextPart（`synthetic: true`，`metadata.kind: "lifecycle-interruption"`），不增加 Message 类型、SQL 列或第二套历史日志。正常收完的无正文 length/filter 由此保存可信 tokenUsage。工具阶段取消不修改原 assistant 的成功请求终态。
