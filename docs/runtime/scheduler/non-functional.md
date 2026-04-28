# scheduler 模块 non-functional.md

本文档定义 `runtime/scheduler` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，当约束冲突时以此为准：

1. **Reminder 的 at-least-once 触发语义**（首要）：Reminder 一旦注册且进程未崩溃，必须在 fireAt 时间到达后发出 JobFired 事件，不允许静默丢失。at-least-once 的意思是：宁可重复触发（如启动恢复时发现 overdue Reminder），不可漏触发。

2. **内存状态与 DB 状态的最终一致**：tick 触发后的 DB 写入（SchedulerStore.update / markCompleted）允许短暂延迟，但不允许长期不一致。进程重启后，loadActive() 应能恢复到正确的 job 状态。

3. **tick 不阻塞 Bus 发布**：JobFired 是发布操作，tick 不应等待 heartbeat 消费后才继续。tick 和 heartbeat 的处理通过 Bus 解耦，scheduler 不关心 Run 是否被创建。

---

## 二、Operational Constraints（运行约束）

### 触发精度

- scheduler 基于 Node.js `setTimeout` 实现，不提供精确到毫秒的触发保证
- 可接受的触发偏差：几十到几百毫秒（取决于 event loop 负载），不要求亚毫秒精度
- 偏差方向：只允许延迟触发（fireAt 时刻之后触发），不允许提前触发（fireAt 之前发出 JobFired）
- ScheduledJob 的周期任务：nextFireTime 应基于调度规则计算，而不是简单使用"当前实际触发时间 + 间隔"；若发生延迟或错过窗口，应推进到下一个大于 now 的计划时间，避免漂移积累和启动时补偿风暴

### 启动恢复的突发触发

- 进程重启后，loadActive() 可能加载大量历史 overdue job（尤其是 Reminder）
- tick 在启动后会立即批量发出这些 overdue job 的 JobFired
- 这是预期行为；heartbeat 需要能承受启动瞬间的信号突发
- 当前阶段不对突发量设限；若未来 Reminder 数量很大，可考虑批量触发的速率限制

### DB 写入失败的容忍

- SchedulerStore 写入失败（update / markCompleted）不中断 tick 的执行
- 失败时记录日志；MinHeap 的内存状态不回滚（保持触发语义）
- 进程重启后 loadActive() 会以 DB 状态为准恢复；内存与 DB 的短暂不一致在重启后消除

### FollowUp 的内存限制

- FollowUp 是纯内存结构，不持久化；进程重启后全部丢失
- FollowUp 的生命周期很短（由 heartbeat 注册，通常在几秒到几分钟内触发）
- 当前阶段不对内存中的 FollowUp 数量设上限；HeartbeatMachine 的 sleeping 语义保证每 session 最多一个 active FollowUp

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- Reminder 在 fireAt 到达后未发出 JobFired（非进程崩溃原因）：违反 at-least-once 语义，不可接受
- tick 因 SchedulerStore 写入失败而抛出未捕获异常，导致 setTimeout 不再注册：scheduler 停止运转，不可接受
- ScheduledJob 的 nextFireTime 计算错误导致触发时间单调递减（无限快速触发）：应在计算层检验，nextFireTime 必须大于当前时间

### 可接受的失败

- 单次 SchedulerStore.update() 失败：内存状态正确，DB 短暂不一致，下次重启恢复
- heartbeat 消费 JobFired 失败或超时：scheduler 不感知，不重试；heartbeat 侧的 disposition 处理是独立的
- cancel() 调用时 job 不存在（已触发或已删除）：幂等返回，不报错

### 可观测性

- 每次 tick 执行应记录：触发的 job 数量、各 job 的 jobId 和 kind
- SchedulerStore 写入失败应记录结构化日志（jobId、操作类型、错误原因）
- 启动恢复时应记录 loadActive() 加载的 job 数量，以及其中 overdue 的数量
- 每次 addReminder / addScheduledJob / addFollowUp 应记录（jobId、fireAt / cron、sessionId）

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：精确触发时间的硬保证

基于 `setTimeout` 的实现无法保证精确触发。当前场景（agent 的定时唤醒、用户提醒）对时间精度的要求是秒级可接受，不需要毫秒级精度。若未来需要高精度定时（如金融场景），需要替换为系统级定时机制（如操作系统 alarm），但这超出当前架构范围。

### 当前不追求：deferred Reminder 的自动重试

deferred Reminder 在 heartbeat 重启后可能成为孤立记录（heartbeat DeferredQueue 丢失）。当前阶段不做自动检测和重新触发。若需要更强的 Reminder 可靠性保证，需要引入"Reminder 状态巡检"机制（定期扫描 active 但 overdue 的 Reminder），当前阶段暂缓。

### 当前不追求：FollowUp 的持久化恢复

FollowUp 进程重启后丢失是已知约束，由 heartbeat 和 run-manager 联合处理（markInterrupted + 重新调度）。FollowUp 持久化意义不大，因为 sleeping 语义本身就是短期的，进程崩溃后 Run 已被标记为 interrupted，重新决策续跑是更合适的处理方式。
