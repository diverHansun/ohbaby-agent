# 子代理消息与结果输入

主会话用户输入、Goal 和后台结果唤醒共用 adapter 的 SessionExecutionGate。子代理运行期间接受的 send 使用 child run 的 CurrentRunInputStore，直接进入该次子执行。

输入来源为 `user-steer`、`subagent-message`、`subagent-result`、`subagent-status`。数据库迁移 028 扩展 source 约束，保留原输入、索引和外键。每条输入绑定 session、scope、run、message 和稳定 source 身份，已接受的请求成员关系不得搬迁。

`admitRequestAttempt` 固定当前请求输入集合；`confirmRequestSuccess` 只确认真正成功的请求。失败或中断的 runtime 消息保留审计证据，但未 processed 的子代理消息不重新混入模型历史。子代理结果由 session 级 execution 台账持有，下一轮使用新的 inputId 重投，sourceId 不变。

空闲结果唤醒在共享执行门成功预留之后调用 `claimWakeup`。被拒绝准入的结果保留唤醒机会。已获得过自动处理机会的结果可随之后的用户输入或新结果再次交付，同一条结果只主动唤醒一次。用户停止主 run 后，仍在后台运行的子任务可以交回结果。

正常运行期间由程序检查执行状态。收到子任务的成功、失败或超时结果后，运行中的主 run 可接收 `subagent-result`。如果主代理空闲并获准开一个主 run，运行时会在首次模型请求前写入带 `subagent-status` 来源的唤醒消息。这条 run 在账本里的 `trigger` 为 `subagent`。

主模型可以先做完当前能独立推进的工作。主 run 成功结束且仍有该 Goal 的后台执行时，Goal driver 等待子任务结果。Goal 接手结果时继续使用自身的预算和 Todo 作用域。用户暂停的 Goal 保留暂停状态。

对应实现：`runtime/prompt-scheduler/current-run-inputs.ts`、`agents/subagents/continuation-coordinator.ts`、`agents/subagents/session-supervisor.ts`、`adapters/ui-inprocess.ts`。
