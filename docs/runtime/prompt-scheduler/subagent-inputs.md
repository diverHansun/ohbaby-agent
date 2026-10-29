# 子代理消息与结果输入

主会话用户输入、Goal、后台结果和监督共用 adapter 的 SessionExecutionGate。子代理运行期间接受的 send 使用 child run 的 CurrentRunInputStore；它不经过主执行门，也不新开 child execution。

输入来源为 `user-steer`、`subagent-message`、`subagent-result`、`subagent-status`。数据库迁移 028 扩展 source 约束，保留原输入、索引和外键。每条输入绑定 session、scope、run、message 和稳定 source 身份，已接受的请求成员关系不得搬迁。

`admitRequestAttempt` 固定当前请求输入集合；`confirmRequestSuccess` 只确认真正成功的请求。失败或中断的 runtime 消息保留审计证据，但未 processed 的子代理消息不重新混入模型历史。子代理结果由 session 级 execution 台账持有，下一轮使用新的 inputId 重投，sourceId 不变。

空闲结果唤醒在共享执行门成功预留之后 claimWakeup；拒绝准入不消费唤醒机会。同一个结果已经获得过自动处理机会后，不因该轮失败再次自动开启主轮次，仍可随新用户输入、新结果或允许的监督处理。用户 Stop 使旧 timer generation 失效，不能阻止随后真正的新结果。

监督提示在 RunManager 标记 running 后、第一模型请求前持久写入，并带 `subagent-status` origin。真实结果到达会撤销尚未发送的旧监督观察；用户输入与观察的并发沿用输入存储的事务检查。

Goal 沿用可观察的轮次边界：主模型先做完当前能独立推进的工作，再结束本轮；本轮自然结束且仍有该 Goal 的后台执行时 driver 等待结果或监督。程序不解析自然语言来猜测业务上是否还有独立工作。Goal 归属和预算覆盖结果处理轮及其派生执行；普通用户 Stop 不通过后台通知恢复被暂停的 Goal。

对应实现：`runtime/prompt-scheduler/current-run-inputs.ts`、`agents/subagents/continuation-coordinator.ts`、`agents/subagents/session-supervisor.ts`、`adapters/ui-inprocess.ts`。
