# 子代理消息与结果输入

主会话用户输入、Goal 和后台结果唤醒共用 adapter 的 SessionExecutionGate。子代理运行期间接受的 send 使用 child run 的 CurrentRunInputStore，直接进入该次子执行。

输入来源为 `user-steer`、`subagent-message`、`subagent-result`、`subagent-status`。数据库迁移 028 扩展 source 约束，保留原输入、索引和外键。每条输入绑定 session、scope、run、message 和稳定 source 身份，已接受的请求成员关系不得搬迁。

`admitRequestAttempt` 固定当前请求输入集合；`confirmRequestSuccess` 只确认真正成功的请求。失败或中断的 runtime 消息保留审计证据，但未 processed 的子代理消息不重新混入模型历史。子代理结果由 session 级 execution 台账持有，下一轮使用新的 inputId 重投，sourceId 不变。

空闲结果唤醒在共享执行门成功预留之后调用 `claimWakeup`。被拒绝准入的结果保留唤醒机会。已获得过自动处理机会的结果可随之后的用户输入或新结果再次交付，每条结果只有一次进入模型请求的自动机会。首个请求之前、且没有 Stop 的入口故障最多额外重试 3 次，按 5/10/20 秒退避；剩余额度和最近唤醒 runId 写在原 execution.delivery，重启不重置。用户停止主 run 后，仍在后台运行的子任务可以交回结果。

正常运行期间由程序检查执行状态。收到子任务的成功、失败、超时或受控故障中断结果后，运行中的主 run 可接收 `subagent-result`。如果主代理空闲并获准开一个主 run，运行时会在首次模型请求前写入带 `subagent-status` 来源的唤醒消息。这条 run 在账本里的 `trigger` 为 `subagent`。

主模型可以先做完当前能独立推进的工作。主 run 成功结束且仍有该 Goal 的后台执行时，Goal driver 等待子任务结果。Goal 接手结果时继续使用自身的预算和 Todo 作用域。用户暂停的 Goal 保留暂停状态。

对应实现：`runtime/prompt-scheduler/current-run-inputs.ts`、`agents/subagents/continuation-coordinator.ts`、`agents/subagents/session-supervisor.ts`、`adapters/ui-inprocess.ts`。

内部 `agents/subagents/delivery.ts` 核对 execution、input、run/request，不保存第二份信箱。输入接收与 execution 关联之间断开时，按同 session/scope 的稳定 sourceId 补关联；成功请求已保存但确认遗漏时，按接收 run 和精确 inputId 成员关系补确认。查询复用既有 session/run 消息索引，不依赖 UI 历史窗口。

运行时消息 ID 为 `runtime:${sourceId}:${runId}`，与持久 inputId 一致，不能使用 UI 局部序号。Stop 贯通建账前准备阶段和已建账运行；触发这轮的结果恢复额度置零，并在释放运行占用前等待写入。顺带接收却尚未请求的结果仍保留自动机会，新结果可携带未消费旧结果。

execution.goalId 的字符串表示 Goal 归属，JSON null 表示普通任务，SQL NULL 表示旧数据未知。自动续跑仍受 Goal ticket、暂停和预算准入约束；用户明确发起的新 run 可以接收保存的旧结果，不隐式恢复 Goal。旧未知归属仅在完整 Goal 历史为空时自动按普通结果处理。

`process-interrupted` 和 `service-shutdown` 新写终态会保留通知。服务关闭期间不启动模型，运行时取得会话恢复所有权后交付；纯读列表和 monitor 不修复、不唤醒。已是 delivery=none 的历史中断不会追溯升级。

实施与验收见 [2026-11-12 投递改进](../../agents/2026-11-12-subagent-delivery/improve-1/05-implementation-acceptance.md)。
