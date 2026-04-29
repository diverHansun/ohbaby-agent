# scheduler 模块 goals-duty.md

本文档定义 `runtime/scheduler` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 以事件驱动代替轮询，实现空闲零 CPU 的时间触发

scheduler 使用最小堆维护所有待触发任务的下次触发时间，通过 `setTimeout` 睡眠到最近的触发点。没有待触发任务时，进程不消耗 CPU。这与 hermes-agent 的 60 秒轮询方案形成对比——hermes 的定期轮询在高频检查时会持续占用资源，且无法精确控制触发时机。

### 2. 统一管理三类时间驱动的触发场景

个人助手需要的时间驱动场景本质上只有三类：周期性重复（cron-like 任务）、一次性延迟（提醒、报警）、续跑等待（agent 主动挂起后的自动继续）。scheduler 将这三类统一建模，而不是为每类单独开发触发机制。

### 3. 只负责产生触发信号，不直接创建 Run

scheduler 的输出是"现在应该触发某任务"的信号，而不是直接创建和管理 Run。由 `runtime/heartbeat` 接收信号并决定当前状态是否允许执行，再由 `runtime/run-manager` 实际创建 Run。这使 scheduler 完全不感知 agent 状态，边界极为清晰。

---

## 二、Duties（职责）

### 1. 维护待触发任务的最小堆

负责：
- 维护一个按 `nextFireTime` 排序的最小堆
- 支持任务的增删改（添加、取消、修改下次触发时间）
- 堆操作为 O(log n)

### 2. 事件驱动的 tick 调度

负责：
- 计算堆顶任务的 `nextFireTime` 与当前时间的差值，调用 `setTimeout` 精确等待
- tick 到达时弹出所有 `nextFireTime <= now` 的任务，依次触发
- 触发后，周期性任务自动计算下次触发时间并重新入堆；一次性任务触发后移除

### 3. 三类触发源的建模

负责：
- **ScheduledJob**：周期性任务（按 cron 表达式或固定间隔），永续执行直到被取消
- **Reminder**：一次性提醒（在指定时刻触发一次后自动移除）
- **FollowUp**：续跑等待（run 主动挂起，scheduler 在 N 秒后产生 follow-up 信号）

### 4. 触发信号的输出

负责：
- 触发时发出 `Scheduler.Event.JobFired` Bus 事件
- 携带触发源信息（jobId、kind）供 heartbeat 决策使用
- 只发布进程内触发信号；如需对外观测，由 `daemon/app-events.ts` 将 Bus 事件翻译为 StreamBridge app scope 事件
- 订阅 `Heartbeat.Event.SignalDisposition` Bus 事件，接收 heartbeat 对每条触发信号的处置回报

### 5. 持久化用户可感知的调度承诺

按三类任务的语义区分持久化策略：

**持久化（写入 `scheduler_job` 表，`services/database`）**：
- **ScheduledJob**（`kind = 'scheduled'`）：用户/配置主动建立的长期规则，重启后必须恢复，否则后台能力不可信
- **Reminder**（`kind = 'reminder'`）：对用户的"到点提醒"承诺，丢失代价高；**`status = completed` 的写入时机由 Ack 协议驱动**

**纯内存（不持久化）**：
- **FollowUp**：agent loop 的内部续跑等待（N 秒后继续），属于进程内部短期 wakeup；重启后由 run-ledger 的 `interrupted` 记录 + heartbeat 或用户交互重新决策

`scheduler_job` 表因此服务于用户可感知的调度承诺，而不是 agent 内部所有 timeout。

### 6. Reminder 的 Ack 驱动完成语义

Reminder 的 `scheduler_job.status` 状态迁移由 heartbeat 的 disposition 回报决定：

| Heartbeat disposition | Reminder status 操作 |
|---|---|
| `accepted` | 更新为 `completed`（run-manager 已接收，至少创建 pending RunRecord / run-ledger 记录） |
| `started` | 更新为 `completed`（run-manager 已确认启动） |
| `deferred` | 保持 `active`，等待后续 disposition |
| `rejected` | 保持 `active`，记录警告日志；可由运维/用户决定是否重试 |

**关键约束**：scheduler 不应在 `Scheduler.Event.JobFired` 发出的同一时刻将 Reminder 标为 `completed`。触发信号发出只代表"时间到了"，不代表"承诺已兑现"。只有 heartbeat/run-manager 真正接受信号后，`completed` 才有意义。

---

## 三、Non-Duties（非职责）

### 1. 不负责 Run 的创建

scheduler 只输出触发信号。创建 Run 是 `runtime/heartbeat`（决策）和 `runtime/run-manager`（执行）的职责。

### 2. 不负责 agent 状态的判断

scheduler 不知道 agent 当前处于 active / paused / blocked / sleeping 状态。即使 agent 正忙，scheduler 也会按时产生触发信号；由 heartbeat 决定是立即执行还是延迟处理。

### 3. 不负责 channel 入站消息的触发

来自 Telegram / Slack / Email 等通道的消息触发由 `interfaces/channels` 处理，不经由 scheduler。scheduler 只处理时间驱动的触发，不处理消息驱动的触发。

### 4. 不负责任务的实际执行内容

scheduler 只触发信号，不知道被触发的任务要做什么（执行哪个 tool、跑哪段代码、通知哪个 session）。执行内容的定义在 ScheduledJob 的配置或 run-manager 的上下文中。

### 5. 不负责 cost / token 的预算控制

hermes 在 scheduler 层加了 cost guard（禁用高费用工具集）。ohbaby 的 cost / token 预算不放在 scheduler 中；后续可由 RunRecord、cost tracker 或 lifecycle 事件聚合承担，scheduler 与这类预算控制解耦。

### 6. 不负责对外事件流发布

scheduler 不直接调用 StreamBridge。对外 app scope 事件由 daemon 层的 `daemon/app-events.ts` 内部 adapter 负责翻译。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/heartbeat` | 被依赖 | heartbeat 接收 scheduler 的触发信号并决定是否允许创建 Run |
| `runtime/run-manager` | 间接依赖 | heartbeat 判断通过后调用 run-manager.create()，scheduler 不直接调用 run-manager |
| `runtime/daemon` | 被持有 | daemon 创建 scheduler 实例，负责启动与停止 |
| `bus` | 发布 | 触发信号通过 Bus 事件通知 heartbeat |
| `runtime/stream-bridge` | 间接发布 | `daemon/app-events.ts` 将 `Scheduler.Event.JobFired` 翻译为 app scope 事件后通过 bridge 发布 |
| `services/database` | 依赖 | ScheduledJob / Reminder 通过 database 模块读写 scheduler_job 表；FollowUp 不持久化 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：scheduler 产生触发信号，不创建 Run
```typescript
// scheduler.ts 负责
onJobFired(job: ScheduledJob) {
  bus.emit(Scheduler.Event.JobFired, {
    event: 'JobFired',
    jobId: job.id,
    kind: 'scheduled',
    priority: 2,
    firedAt: Date.now(),
  })
  // 不调用 runManager.create()
}
```

正确：FollowUp 的续跑等待
```typescript
// scheduler.ts 负责
scheduler.addFollowUp({
  followUpId: 'f-001',
  parentRunId: 'run-abc',
  fireAfterMs: 30_000,  // 30 秒后续跑
})
```

### 5.2 职责外的示例

错误：scheduler 不应判断 agent 状态
```typescript
// 错误：不应该在 scheduler 中
if (heartbeat.getState() !== 'sleeping') {
  return  // 跳过这次触发
}

// 正确：scheduler 始终触发，由 heartbeat 决策
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：scheduler 以最小堆加事件驱动的方式统一管理周期任务、一次性提醒、续跑等待三类时间触发，输出触发信号但不创建 Run
- 能清楚回答"这个模块不该做什么"：不做 Run 创建、不做 agent 状态判断、不做 channel 消息处理、不做任务内容执行、不做 cost 控制、不直接发布对外事件流
- 职责与其他模块无明显重叠：heartbeat（状态机决策）、run-manager（Run 创建）、interfaces/channels（消息驱动触发）边界清晰
- Reminder 的 `completed` 语义清晰：由 heartbeat disposition 回报驱动，不在信号发出时写入
