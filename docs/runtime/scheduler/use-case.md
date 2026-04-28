# scheduler 模块 use-case.md

本文档描述 `runtime/scheduler` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Register a Job | daemon / CLI / API | 接收三类 job，写入堆与持久化 |
| UC2 | Fire Jobs on Tick | setTimeout 到期 | 触发到期 job，发布 JobFired，按类型后处理 |
| UC3 | Complete Reminder via Disposition | heartbeat 回报 Bus 事件 | 根据 disposition 写入 Reminder 完成状态 |

---

## 二、Main Flow Description（主流程描述）

### UC1：Register a Job

三类 job（ScheduledJob / Reminder / FollowUp）统一入口，差异在持久化策略。

```
输入：addScheduledJob / addReminder / addFollowUp（options）
  ↓
1. 分配 jobId
  ↓
2. 计算 nextFireTime
   ├── ScheduledJob：解析 cronExpr 或 intervalMs → 计算下次触发时间
   ├── Reminder：fireAt 即 nextFireTime（一次性）
   └── FollowUp：fireAt 即 nextFireTime（一次性）
  ↓
3. 写入 MinHeap（三类均写）
  ↓
4. 持久化（差异点）：
   ├── ScheduledJob → SchedulerStore.save()
   ├── Reminder     → SchedulerStore.save()（status='active'）
   └── FollowUp     → 仅内存，不写 DB
  ↓
5. 重新计算 tick setTimeout（取堆顶 nextFireTime）
  ↓
输出：jobId；MinHeap 更新；tick 重新对齐
```

---

### UC2：Fire Jobs on Tick

scheduler 的核心执行路径。

```
触发：setTimeout 到期 → tick() 执行
  ↓
1. 从 MinHeap 弹出所有 nextFireTime ≤ now 的 job
  ↓
2. 对每个到期 job，按类型后处理：

  [ScheduledJob]
    → 发布 Bus: Scheduler.Event.JobFired { jobId, kind: 'scheduled', priority: 2, ... }
    → 重新计算 nextFireTime（周期任务继续调度）
    → 重新入堆
    → SchedulerStore.update()（更新 nextFireTime）

  [Reminder]
    → 发布 Bus: Scheduler.Event.JobFired { jobId, kind: 'reminder', priority: 3, ... }
    → 从堆移除（不再重新入堆）
    → 【不立即写 completed】等待 heartbeat 回报 disposition

  [FollowUp]
    → 发布 Bus: Scheduler.Event.JobFired { jobId, kind: 'follow-up', priority: 1, ... }
    → 从堆移除（纯内存，无后续持久化）
  ↓
3. 重新计算下次 tick setTimeout（取新堆顶）
```

**关键设计**：tick 不等待 heartbeat 消费完 JobFired 再继续；tick 与 heartbeat 的处理是异步的，通过 Bus 解耦。

---

### UC3：Complete Reminder via Disposition

heartbeat 处理信号后，回报结果给 scheduler，驱动 Reminder 状态写入。

```
输入：Bus 订阅到 Heartbeat.Event.SignalDisposition { jobId, disposition }
  ↓
1. 查找 jobId 对应的 job 类型
   → 仅 Reminder 参与此协议；ScheduledJob 和 FollowUp 无 disposition 处理
  ↓
2. 按 disposition 决策：
   ├── 'accepted'  → SchedulerStore.markCompleted(jobId)  ← Reminder 完成
   ├── 'started'   → SchedulerStore.markCompleted(jobId)  ← Reminder 完成
   ├── 'deferred'  → 不修改状态，Reminder 保持 status='active'
   └── 'rejected'  → 不修改状态，Reminder 保持 status='active'，记录 warning
  ↓
输出：Reminder 的 DB status 更新（或不变）
```

**注意**：`deferred` 时 Reminder 保持 active，意味着 Reminder 在 DB 中"未完成"，不会被下次 loadActive 忽略。但由于 Reminder 是一次性的（已从堆移除），它不会被再次触发，除非外部重新注册。这是一个需要在实现时明确的边界。

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| jobId 分配 | scheduler | 外部不指定 jobId |
| nextFireTime 计算 | scheduler（jobs/ 子模块）| cron 解析和 interval 计算是 scheduler 内部职责 |
| MinHeap 维护 | scheduler（内部）| 外部不直接操作堆 |
| DB 持久化（ScheduledJob / Reminder）| SchedulerStore（scheduler 调用）| FollowUp 不持久化；这是显式策略，非遗漏 |
| 发布 JobFired | scheduler | 唯一生产者；heartbeat 是消费者 |
| 决定是否创建 Run | heartbeat | scheduler 只触发事件，不关心 Run 是否被创建 |
| Reminder.completed 写入 | scheduler（被 disposition 驱动）| 仅由 heartbeat 回报的 accepted/started 触发 |
| FollowUp 的进程重启策略 | 已知边界 | 由 heartbeat + run-manager 决定是否重新注册 |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：deferred Reminder 的后续处理

**问题**：heartbeat 回报 `deferred`，Reminder 保持 active 状态，但已从堆中移除——它是否会被再次触发？
**当前策略**：不重新触发。deferred 意味着 heartbeat 把信号缓存进了 DeferredQueue，稍后 drain 时会执行；scheduler 不知道这个过程，也不重新注册
**风险点**：若 agent 重启而 DeferredQueue 丢失，deferred Reminder 将永远停留在 active 状态，成为孤立记录。这是一个已知的边界情况，应在实现阶段明确处理策略（如启动时检测 deferred-但-无 FollowUp 的 Reminder）

### 决策点 2：rejected Reminder 的处理

**问题**：heartbeat 回报 `rejected`，Reminder 保持 active，且不会被重新触发
**当前策略**：记录 warning，不自动重试。Reminder 的 at-least-once 语义依赖 heartbeat 侧的保证，而非 scheduler 侧的重试
**影响**：rejected 意味着 heartbeat 在 blocked 状态下拒绝了信号；Reminder 记录保留，等待外部介入或下次手动触发

### 失败点 1：tick 中 SchedulerStore.update() 失败

**场景**：ScheduledJob 触发后更新 nextFireTime 写 DB 失败
**预期行为**：job 已重新入堆（内存），下次 tick 仍会触发；DB 与内存不一致，下次重启会重新加载
**注意**：这是一个一致性窗口，进程内可接受（内存正确），但跨重启可能导致 nextFireTime 偏差

### 失败点 2：启动恢复时 DB 中有 overdue 的 Reminder

**场景**：重启后 loadActive() 加载到大量历史 overdue Reminder
**预期行为**：全部写入 MinHeap；tick 在启动后立即批量触发（nextFireTime ≤ now）
**注意**：可能在启动瞬间发出大量 JobFired，heartbeat 需要能处理突发信号；这是恢复场景的正常行为
