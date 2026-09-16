# Lifecycle 数据流与接口

## 一次运行

1. RunWorker 启动 Lifecycle.run，传 session/model/scope、取消 signal、运行策略和观察回调。
2. 每步解析当前工具，Context.prepareTurn 返回本步实际发送的冻结 messages/tools 与估算。
3. runModelStep 新建 assistant，持续保存及展示真实正文增量。
4. streamResponse 耗尽后，Lifecycle 接受唯一最终候选并发布 llm:complete；晚到错误或 overflow 丢弃候选。
5. 聚合可信 usage、通知 Step observer、用实际请求估算校准。随后完成必要持久化。
6. 正常工具步骤保存完整调用后交 ToolScheduler；结果以 callId 对应回存，再进入下一步。普通业务错误也是工具结果。
7. 无工具正常答复结束；截断、过滤、取消、框架或保存失败分别返回明确终态。

## 完成与保存的顺序

原生步骤使用 commitModelStep 保存正文、续接状态和工具调用。普通路径仍分步保存。两条路径都要求执行工具前保存成功；保存失败返回 model_state_persistence_failure 并保留已接受 usage。记录失败本身再次写失败时，仍应向运行层报告原保存故障和已接受用量。

length/content_filter 只接受请求完成与用量，不接受该输出中的工具/native，不自动继续生成。SDK 自报 abort 而本地没取消按请求失败处理，不标用户取消。

## 接受前后的取消

接受前取消不发模型完成、不观察可信 Step、不校准；已有正文可留存，观测用量仅作 Run 部分汇总。接受后取消保留真实完成与可信用量。工具阶段取消先保存已经收到的结果，不能把已完成操作假装回滚。

RunWorker 按运行结果和取消 signal 结束 UI 等待；UI 不能等待一个为了收尾而伪造的 llm:complete。

## 重试与上下文

无有效输出时按既有 SDK/项目策略有限重试。正文、推理或工具参数出现后项目不重发。llm:retrying 只反映外层次数。Context overflow 保留一次 force prepare 后恢复，使用新的 PreparedTurn；不把旧步骤候选或估算复用到恢复请求。

普通请求、摘要、计量使用 Context 的现有入口；95% 完整模型窗口触发及压缩算法不在 Lifecycle 中重新实现。切模型复用现有产品入口重建 runtime。

## 边界调用

- 输入：LifecycleSessionParams 与可选 LifecycleConfig。
- 输出：AsyncGenerator<LifecycleEvent, LifecycleResult>。
- Context：createRunPromptSnapshot、prepareTurn、updateCalibrationFactor。
- Message：createMessage、updateMessage、appendPart、updatePart、commitModelStep。
- ToolScheduler：executeBatch，结果对应原 callId。
- 运行层：RunWorker 消费事件和返回值；最终状态不由单一流事件决定。
