# scheduler 模块 dfd-interface.md

> **2026-07-13 修订（优先）**：到期后的数据流以 [`docs/loop/dfd-interface.md`](../../loop/dfd-interface.md) 为准：`Scheduler Due → Loop 投递门控 → PromptScheduler`。本文件只描述闹钟注册/恢复/到期通知接口。  
> **2026-07-11 修订**：job 注册必填 `scopeKey + sessionId`；不得发布到无 scope 隔离的机器级 Heartbeat。下文旧 Bus/Heartbeat disposition 接口视为过时。

本文档描述 `runtime/scheduler` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

scheduler 是 runtime 的时间驱动层，与以下模块发生直接数据交换：

| 方向 | 外部模块 | 交互类型 |
|---|---|---|
| 被调用 | daemon/bootstrap | 注册 job（addScheduledJob / addReminder / addFollowUp）、cancel、start、stop |
| 被调用 | CLI / API | 通过 daemon 间接注册/取消 job（用户创建提醒、定时任务）|
| 被调用 | heartbeat（事件） | 订阅 `Heartbeat.Event.SignalDisposition` Bus 事件 |
| 发布（Bus） | heartbeat | 发布 `Scheduler.Event.JobFired` Bus 事件 |
| 持久化 | services/database | 通过 SchedulerStore 读写 `scheduler_job` 表 |

**讨论范围**：本文档关注 scheduler 的外部接口和 Bus 事件协议，不涉及 MinHeap 的堆操作实现细节。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Job 注册

```
调用方（daemon / CLI）提交 job 参数
  ├── addScheduledJob({ cronExpr?, intervalMs?, sessionId? })
  ├── addReminder({ fireAt, sessionId? })
  └── addFollowUp({ fireAt, sessionId })
  ↓
scheduler 分配 jobId
  ↓
计算 nextFireTime
  ├── ScheduledJob：解析 cronExpr 或 intervalMs → 得到下次触发时间
  ├── Reminder：fireAt 即 nextFireTime
  └── FollowUp：fireAt 即 nextFireTime
  ↓
写入 MinHeap（所有三类 job）
  ↓
ScheduledJob / Reminder → SchedulerStore.save()（持久化）
FollowUp → 仅写内存（不持久化）
  ↓
重新计算 tick setTimeout（取堆顶 nextFireTime）
```

### 流程 2：Job 触发（tick 到达）

```
setTimeout 到期 → tick() 执行
  ↓
从 MinHeap 弹出所有 nextFireTime ≤ now 的 job
  ↓
对每个到期 job：
  ↓
  发布 Scheduler.Event.JobFired {
    jobId, kind, sessionId?, priority, firedAt
  } 到 Bus
  ↓
  ├── ScheduledJob → 重新计算 nextFireTime → 重新入堆 → SchedulerStore.update()
  ├── Reminder → 从堆移除（等待 disposition 才写 completed）
  └── FollowUp → 从堆移除（纯内存，无后续持久化）
  ↓
重新计算下次 tick setTimeout（取新堆顶）
```

### 流程 3：Reminder 完成确认（disposition 协议）

```
heartbeat 处理 JobFired 后，通过 Bus 回报：
Heartbeat.Event.SignalDisposition {
  jobId, disposition: 'accepted' | 'started' | 'deferred' | 'rejected'
}
  ↓
scheduler 接收 disposition：
  ├── 'accepted' → SchedulerStore.markCompleted(jobId)  ← Reminder 完成
  ├── 'started'  → SchedulerStore.markCompleted(jobId)  ← Reminder 完成
  ├── 'deferred' → 不修改状态，Reminder 保持 'active'
  └── 'rejected' → 不修改状态，Reminder 保持 'active'，记录 warning
  ↓
[注意：scheduler 触发 JobFired 时不立即写 completed；仅由 disposition 驱动]
```

### 流程 4：Job 取消

```
cancel(jobId) 调用
  ↓
MinHeap 按 jobId 删除条目
  ↓
SchedulerStore.markCancelled(jobId)（若为 ScheduledJob 或 Reminder）
  ↓
重新计算 tick setTimeout
```

### 流程 5：启动恢复（start）

```
scheduler.start() 调用（daemon 启动时）
  ↓
SchedulerStore.loadActive()
  → 读取 scheduler_job 表中 status='active' 的所有 job
  ↓
逐条写入 MinHeap（重建内存状态）
  ↓
FollowUp 不持久化，进程重启后丢失（由 heartbeat 重新决策是否续跑）
  ↓
计算首次 tick setTimeout
```

---

## 三、Interface Definition（接口定义）

### 接口 1：addScheduledJob(options)

**语义**：注册一个周期性定时任务。

- **输入**：`{ cronExpr?, intervalMs?, sessionId? }`（至少提供一种时间规则）
- **输出**：`jobId: string`
- **持久化**：是（scheduler_job 表）
- **同步/异步**：异步（写 DB）

### 接口 2：addReminder(options)

**语义**：注册一次性提醒，具有 at-least-once 语义（不会因队列满而静默丢弃）。

- **输入**：`{ fireAt: number, sessionId? }`
- **输出**：`jobId: string`
- **持久化**：是（scheduler_job 表，status 由 disposition 驱动 → completed）
- **同步/异步**：异步

### 接口 3：addFollowUp(options)

**语义**：注册 agent 主动挂起后的续跑唤醒（短期纯内存 wakeup）。

- **输入**：`{ fireAt: number, sessionId: string }`
- **输出**：`jobId: string`
- **持久化**：否（进程重启后丢失）
- **同步/异步**：同步

### 接口 4：cancel(jobId)

**语义**：取消指定 job，从堆移除并更新持久化状态。

- **同步/异步**：异步（若需写 DB）

### 接口 5：start() / stop()

**语义**：`start()` 从 DB 恢复 active jobs 并启动 tick 循环；`stop()` 停止 tick 循环并清空内存状态。

- **调用时机**：daemon 启动/关闭时

### Bus 事件：Scheduler.Event.JobFired（输出）

**语义**：通知 heartbeat 有 job 到期触发。

```typescript
{
  event: 'JobFired'
  jobId: string
  kind: 'scheduled' | 'reminder' | 'follow-up'
  sessionId?: string
  priority: number  // reminder=3, scheduled=2, follow-up=1
  firedAt: number  // 实际触发时间（毫秒 epoch）
}
```

### Bus 事件：Heartbeat.Event.SignalDisposition（输入，订阅）

**语义**：heartbeat 回报信号处理结果，驱动 Reminder 的 completed 状态写入。

```typescript
{
  jobId: string
  disposition: 'accepted' | 'started' | 'deferred' | 'rejected'
  sessionId?: string
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 所有者 | 责任边界 |
|---|---|---|---|
| ScheduledJob / Reminder 记录（DB）| scheduler（SchedulerStore）| scheduler | 唯一写入方；status 变更由 scheduler 驱动 |
| FollowUp（内存）| scheduler | scheduler（临时）| 进程重启后丢失，heartbeat 重新决策 |
| nextFireTime 计算 | scheduler（jobs/ 模块）| scheduler | cron 解析和 interval 计算是 scheduler 内部职责 |
| Reminder.completed 状态 | SchedulerStore | scheduler | 仅在 disposition='accepted' 或 'started' 后写入；触发事件不触发写入 |
| JobFired 事件 | scheduler | Bus | scheduler 负责发布；heartbeat 负责消费和回报 |
| disposition 语义 | heartbeat | heartbeat | heartbeat 决定接受/延迟/拒绝信号；scheduler 只被告知结果 |
