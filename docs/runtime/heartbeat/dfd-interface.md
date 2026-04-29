# heartbeat 模块 dfd-interface.md

本文档描述 `runtime/heartbeat` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

heartbeat 是 agent 运行状态机的持有者，位于"触发信号"与"Run 创建"之间的决策层。

| 方向 | 模块 | 通信方式 |
|---|---|---|
| 接收信号 | `runtime/scheduler` | Bus 订阅（`Scheduler.Event.JobFired`） |
| 接收信号 | `interfaces/channels` ChannelDispatcher | Bus 订阅（`ChannelDispatcher.Event.WakeRequested`） |
| 发布结果 | `runtime/scheduler` | Bus 发布（`Heartbeat.Event.SignalDisposition`） |
| 调用外部 | `runtime/run-manager` | 方法调用（`runManager.create()`） |
| 被控制 | `runtime/daemon` / supervisor | 方法调用（`getState / setState / start / stop`） |

**特别说明**：heartbeat 与 scheduler / ChannelDispatcher 的交互**完全通过 Bus 事件**完成，不存在直接的方法调用依赖。heartbeat 不主动轮询任何外部模块，所有输入均为事件驱动。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：JobFired 信号处理（主路径）

```
Scheduler
  → Bus: Scheduler.Event.JobFired { jobId, kind, sessionId?, priority }
  ↓
HeartbeatMachine 按当前状态决策：

  [state = active]
    → mapSignalToTrigger(kind)
       - reminder / scheduled → triggerSource: 'scheduler'
       - follow-up → triggerSource: 'follow-up'
       - channel → triggerSource: 'channel'
    → runManager.create({ triggerSource, sessionId })
    → Bus: SignalDisposition { jobId, disposition: 'accepted' }

  [state = paused]
    → DeferredQueue.enqueue(signal)
      ├─ 入队成功 → disposition: 'deferred'
      └─ 队列满且无法驱逐 → disposition: 'rejected'
    → Bus: SignalDisposition { jobId, disposition }

  [state = sleeping]
    ├─ priority 足够 或 kind='reminder' → 提前唤醒
    │   → setState('active')
    │   → runManager.create(...)
    │   → Bus: SignalDisposition { jobId, disposition: 'accepted' }
    └─ priority 不足 → 不创建 Run
        → Bus: SignalDisposition { jobId, disposition: 'rejected' }

  [state = blocked]
    → 不创建 Run
    → 若为 scheduler 信号，Bus: SignalDisposition { jobId, disposition: 'rejected' }
```

### 流程 2：WakeRequested 信号处理（ChannelDispatcher 触发）

处理路径与流程 1 相同，区别在于：
- 输入来源为 `ChannelDispatcher.Event.WakeRequested`
- WakeSignal 已携带 `sessionId`（ChannelDispatcher 已完成 session 归属）
- heartbeat 直接消费，不再做 session 查找
- channel 信号没有 `scheduler_job.status`，因此不需要 scheduler 消费的 `SignalDisposition`；如需观测处理结果，应通过 app scope 事件或日志表达，不复用 Reminder 的完成协议

### 流程 3：paused → active 恢复（DeferredQueue drain）

```
daemon/supervisor 调用 setState('active')
  ↓
HeartbeatMachine 状态由 paused → active
  ↓
DeferredQueue.drain()（按优先级：Reminder → ScheduledJob → FollowUp）
  ↓
对每条信号：
  → mapSignalToTrigger(kind) → runManager.create({ triggerSource, sessionId })
  → 若 signal 带 jobId，Bus: SignalDisposition { jobId, disposition: 'accepted' }
```

### 流程 4：sleeping 注册与 follow-up 唤醒

```
run-manager 通知 heartbeat：agent 请求 sleeping N 秒
  { durationMs }
  ↓
HeartbeatMachine.onAgentSleepRequest()
  → scheduler.addFollowUp({ fireAfterMs: durationMs, sessionId })
  → setState('sleeping')，记录预期唤醒时间
  ↓
（N 秒后）
Scheduler 发出 JobFired { kind: 'follow-up' }
  ↓
HeartbeatMachine 识别为 sleeping 状态下 follow-up 触发
  → setState('active')
  → runManager.create({ triggerSource: 'follow-up', sessionId })
```

---

## 三、Interface Definition（接口定义）

### Bus 事件：Scheduler.Event.JobFired（订阅）

```typescript
{
  signalId: string
  jobId: string
  kind: 'reminder' | 'scheduled' | 'follow-up'
  sessionId?: string
  priority: number    // Reminder=3, ScheduledJob=2, FollowUp=1
}
```

**语义**：scheduler tick 到期，某 job 触发。heartbeat 依据当前状态决策处理路径。

### Bus 事件：ChannelDispatcher.Event.WakeRequested（订阅）

```typescript
{
  signalId: string
  kind: 'channel'
  sessionId: string   // 已由 ChannelDispatcher 完成归属
  priority: number
}
```

**语义**：入站消息完成 session 归属后发出，heartbeat 统一视为 WakeSignal 处理。

### Bus 事件：Heartbeat.Event.SignalDisposition（发布）

```typescript
{
  jobId: string
  disposition: 'accepted' | 'started' | 'deferred' | 'rejected'
  sessionId?: string
}
```

**disposition 与 Reminder 完成状态的关系**：

| disposition | scheduler 侧行为 |
|---|---|
| `accepted` | Reminder 可写 `status = completed` |
| `started` | Reminder 可写 `status = completed` |
| `deferred` | Reminder 保持 `status = active`（队列中等待）|
| `rejected` | Reminder 保持 `status = active`，记录 warning |

**消费方**：scheduler 订阅此事件，用于驱动 Reminder 的 `completed` 写入。

### 方法调用：runManager.create()（heartbeat 主动调用）

**语义**：heartbeat 在决策通过时调用，触发一次新的 Run。

- **输入**：`{ triggerSource: 'scheduler' | 'channel' | 'follow-up', sessionId? }`
- heartbeat 根据 WakeSignal kind 映射出 `triggerSource`，不传入 permissionProfileId，由 run-manager 根据 triggerSource 查找 RunDefaultsPolicy

### 控制接口（被 daemon/supervisor 调用）

| 方法 | 调用场景 | 说明 |
|---|---|---|
| `start()` | daemon 启动 | 开始订阅 Bus 事件，进入 active 状态 |
| `stop()` | daemon 退出 | 取消 Bus 订阅，停止处理新信号 |
| `getState()` | 状态查询 | 返回当前 AgentState，同步 |
| `setState(state)` | 用户暂停/恢复 | 触发状态转换；paused→active 时自动 drain DeferredQueue |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 归属 | 说明 |
|---|---|---|
| `AgentState` | heartbeat（HeartbeatMachine 内部）| 外部只读（getState）或触发转换（setState）|
| `DeferredQueue`（信号缓冲）| heartbeat（私有）| 外部不可见；paused→active 时 drain |
| `WakeSignal` | 由 Bus 事件产生，heartbeat 消费 | 一次性值对象，处理完毕即释放，不持久化 |
| `SignalDisposition` | heartbeat 产生，scheduler 消费 | Bus 事件，一次性传递 |
| `scheduler_job.status` | scheduler 写入 | heartbeat 通过 disposition 间接驱动，不直接读写 DB |
| `RunRecord` | run-manager 写入 | heartbeat 调用 create() 后由 run-manager 全权管理 |
| sleeping 唤醒时间 | heartbeat 内存 | sleeping 期间有效；进程重启后不恢复，FollowUp 对应入 scheduler |
