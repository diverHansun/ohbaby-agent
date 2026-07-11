# heartbeat 模块 goals-duty.md

> **2026-07-11 目标修订（优先于下文旧方案）**：Heartbeat 的合理边界是“某个 workspace 的某个 session 是否适合接受自动触发”，而不是“整台机器上的 agent 是否可运行”。因此它不是进程级单例；状态和缓冲必须按 `scopeKey + sessionId` 隔离。当前 global-single-daemon 批次不实现该模块，只为后续 session 级 `/loop` 固定边界。

本文档定义 `runtime/heartbeat` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 作为 agent 的状态机，隔离"时间到了"与"能不能跑"

scheduler 负责产生"时间到了"的触发信号，但不知道 agent 当前是否允许执行。heartbeat 作为两者之间的状态机，持有 agent 的运行状态（active / paused / blocked / sleeping），在收到触发信号后判断是否应该创建 Run。这使 scheduler 和 run-manager 都不需要了解 agent 状态，职责边界清晰。

### 2. 防止"心跳等于 LLM 调用"导致的成本失控

最直接的实现是：每次定时器触发就调用 LLM。这是 hermes-agent 早期版本的问题（issue #6130）。heartbeat 的设计目标之一就是将"唤醒信号"与"执行决策"分离，通过状态机过滤掉不应执行的唤醒（agent 暂停中、已有 run 在跑、用户配置了 read-only 策略等）。

### 3. 支持 agent 主动进入 sleeping 状态后的自动唤醒

agent loop 在某些情况下会主动挂起（如等待用户确认、等待外部数据）并告知 heartbeat"N 秒后唤醒"。heartbeat 将这个请求转发给 scheduler（创建一个 FollowUp），并将自身状态设为 sleeping，待 scheduler 触发时恢复 active。

---

## 二、Duties（职责）

### 1. 维护 agent 运行状态

负责：
- 持有状态枚举：`active`（可接受新 run）/ `paused`（用户主动暂停）/ `blocked`（等待条件满足）/ `sleeping`（主动挂起，有唤醒时间）
- 提供 `getState()` / `setState()` 接口
- 状态转换时通过 Bus 发布 `Heartbeat.Event.StateChanged` 事件

### 2. 接收触发信号并决策

负责：
- 订阅 `Scheduler.Event.JobFired` Bus 事件
- 订阅 `ChannelDispatcher.Event.WakeRequested` Bus 事件（channel 入站消息已经完成 session 归属）
- 收到标准化后的 WakeSignal 后，根据当前状态判断：
  - `active`：调用 `run-manager.create()` 启动 Run
  - `paused`：记录到 deferred 队列，暂不执行
  - `sleeping`：根据触发源决定是否提前唤醒
  - `blocked`：忽略触发（等待 blocked 条件解除）

### 3. 管理 deferred 队列（优先级 + Ack 协议）

负责：
- 在 `paused` 状态下接收到的触发信号进入 deferred 队列
- 状态恢复为 `active` 时，按优先级顺序处理 deferred 队列中的触发
- **优先级定义**（高到低）：
  1. **Reminder**：用户可感知的"到点提醒"承诺，at-least-once 语义，不可静默丢弃
  2. **ScheduledJob**：周期性后台任务，可合并重复触发
  3. **FollowUp**：agent 续跑等待，优先级最低，可丢弃
- **队列满时的驱逐策略**：
  - 新信号到达且队列满时，按优先级从低到高驱逐现有条目（先驱逐 FollowUp，再驱逐 ScheduledJob）
  - 如果队列中全为 Reminder 且新信号也是 Reminder，拒绝新信号并记录警告日志
  - Reminder 绝不会因为队列满而被静默丢弃
- **Ack/Disposition 协议**：heartbeat 向 scheduler 回报每条信号的处置结果：
  - `accepted`：`run-manager.create()` 已成功接收信号，并至少创建了 pending RunRecord / run-ledger 记录
  - `deferred`：信号进入 deferred 队列等待
  - `rejected`：信号被拒绝（队列满且无法驱逐）
  - `started`：run-manager 已确认 Run 启动（由 run-manager 回调通知）
- Reminder 的 `scheduler_job.status = completed` 仅在 scheduler 收到 `started` 或 `accepted` disposition 后才写入；`deferred` 和 `rejected` 不触发 completed

### 4. 主动挂起与恢复的协调

负责：
- 接收 `runtime/run-manager` 发出的"agent 请求 sleeping N 秒"信号
- 调用 `scheduler.addFollowUp(parentRunId, fireAfterMs)` 注册续跑
- 将自身状态设为 sleeping，记录预期唤醒时间
- follow-up 触发时恢复 active 并通知 run-manager

### 5. 状态的外部可见性

负责：
- 通过 Bus 发布状态变更事件，供 UI store 或 `daemon/app-events.ts` 消费
- 提供同步 `getState()` 接口，供 daemon 在优雅退出时判断是否有待处理信号

---

## 三、Non-Duties（非职责）

### 1. 不负责时间计算和 tick 调度

时间触发的精确计算（最小堆、setTimeout）由 `runtime/scheduler` 负责。heartbeat 只是信号的消费方和决策方。

### 2. 不负责 Run 的创建和管理

heartbeat 调用 `run-manager.create()` 这一行为是它的职责边界。Run 的 RunRecord 维护、worker 启动、并发冲突处理由 `runtime/run-manager` 负责。

### 3. 不负责 channel 消息的解析

来自 Telegram / Slack 的消息标准化由 `interfaces/channels` 负责；消息归属哪个 session、是否需要创建新 session，由 ChannelDispatcher 负责。heartbeat 接收的是已经带有 sessionId 和 triggerSource 的 WakeSignal，不解析原始消息格式，也不找/建 session。

### 4. 不负责权限画像的选择

触发源与权限画像的默认映射由装配层的 `RunDefaultsPolicy` 定义。heartbeat 在调用 `run-manager.create()` 时传入 `triggerSource`，由 run-manager 查表选择权限画像，heartbeat 不内嵌这个映射逻辑。

### 5. 不负责用户交互式请求的处理

用户在 CLI 主动发起的请求不经过 heartbeat。heartbeat 只处理自动化触发（scheduler / channel / follow-up）。CLI 交互由 `interfaces/cli` 直接调用 `run-manager.create({ triggerSource: 'user', ... })`。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/scheduler` | 接收信号 | 订阅 scheduler 的 JobFired 事件作为触发输入 |
| `runtime/run-manager` | 依赖 | 决策通过时调用 run-manager.create() |
| `runtime/daemon` | 被持有 | daemon 创建 heartbeat 实例，负责启动与停止 |
| `interfaces/channels` / ChannelDispatcher | 接收信号 | 接收已完成 session 归属的 WakeSignal 作为触发输入 |
| `bus` | 订阅 + 发布 | 订阅触发信号，发布状态变更事件 |
| `runtime/permission-profiles` | 间接依赖 | 通过 run-manager.create() 的 triggerSource 参数触发权限画像选择 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：heartbeat 收到触发信号后根据状态决策，并回报 disposition
```typescript
// heartbeat/machine.ts 负责
bus.on(Scheduler.Event.JobFired, async ({ jobId, kind, sessionId }) => {
  if (this.state === 'active') {
    await runManager.create({ triggerSource: 'scheduler', sessionId, ... })
    // create 成功表示信号已被 run-manager 接收；started 可作为后续幂等确认
    return bus.emit(Heartbeat.Event.SignalDisposition, { jobId, disposition: 'accepted' })
  } else if (this.state === 'paused') {
    const enqueued = this.deferredQueue.enqueue({ jobId, kind, sessionId })
    const disposition = enqueued ? 'deferred' : 'rejected'
    bus.emit(Heartbeat.Event.SignalDisposition, { jobId, disposition })
  }
})
```

正确：处理 agent 主动挂起请求
```typescript
// heartbeat/machine.ts 负责
onAgentSleepRequest(parentRunId: string, durationMs: number) {
  scheduler.addFollowUp({ parentRunId, fireAfterMs: durationMs })
  this.setState('sleeping')
}
```

### 5.2 职责外的示例

错误：heartbeat 不应内嵌权限画像映射
```typescript
// 错误：不应该在 heartbeat 中
const profile = triggerSource === 'scheduler' ? 'notify-only' : 'interactive'
await runManager.create({ triggerSource, permissionProfile: profile, ... })

// 正确：只传 triggerSource，由 run-manager 查联动表
await runManager.create({ triggerSource: 'scheduler', sessionId, ... })
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：heartbeat 是 agent 的运行状态机，在 scheduler / channel 的触发信号到达时决定是否创建 Run，防止不合时宜的自动执行
- 能清楚回答"这个模块不该做什么"：不做时间计算、不做 Run 管理、不做 channel 消息解析、不做权限画像选择、不处理用户主动请求
- 职责与其他模块无明显重叠：scheduler（时间触发）、run-manager（Run 创建）、permission-profiles（权限映射）、interfaces/channels（消息处理）边界清晰
- deferred 队列使用优先级策略，Reminder 不可静默丢弃，completed 语义由 ack/disposition 协议驱动
