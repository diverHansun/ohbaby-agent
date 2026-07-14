# scheduler 模块 data-model.md

> **2026-07-13 修订（优先）**：Loop 任务字段与 pending/coalesce/pause/stale 语义以 [`docs/loop/data-model.md`](../../loop/data-model.md) 为准。本文件侧重闹钟行与 `nextFireTime`；与 loop 冲突时改本文件或删除过时段落。  
> **2026-07-11 数据模型修订**：job 必须绑定 `scopeKey + sessionId`；当前批次若尚未建表，与 Loop 实现同批 migration。下文若仍写机器级 Heartbeat 确认 Reminder，视为过时。

本文档定义 `runtime/scheduler` 模块的核心概念与数据模型，统一认知语言，不冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1：Job（调度作业）

scheduler 管理的可调度工作单元，代表"在某个时间点触发一次行为"的承诺。Job 是 scheduler 的核心实体，有三种变体，职责和持久化行为各不相同。

### 概念 2：ScheduledJob（定时任务）

用户或 agent 注册的**周期性**调度承诺。每次触发后自动重新计算 nextFireTime 并入堆。代表"每天/每小时/每隔 N 分钟执行一次"的语义。持久化到 `scheduler_job` 表，进程重启后可恢复。

### 概念 3：Reminder（提醒）

一次性调度承诺，具有 **at-least-once 语义**：Reminder 的完成状态（`completed`）仅在 heartbeat 确认接受后才写入，不因 heartbeat deferred queue 溢出、heartbeat 繁忙等情况静默丢失。代表"在 T 时刻提醒 agent"的语义。持久化到 `scheduler_job` 表。

### 概念 4：FollowUp（续跑唤醒）

agent 主动挂起（sleeping）后注册的**一次性纯内存唤醒**。代表"N 秒后唤醒并续跑"的语义。不持久化，进程重启后丢失（由 heartbeat 重新决策是否续跑）。

### 概念 5：nextFireTime（下次触发时间）

MinHeap 的排序键，表示 Job 应该在哪个时刻被触发（毫秒 epoch）。scheduler 根据堆顶的 nextFireTime 精确 setTimeout，不做轮询。

### 概念 6：Disposition 协议（scheduler 视角）

scheduler 发出 `JobFired` 事件后，异步等待 heartbeat 通过 `SignalDisposition` 事件回报处理结果。这个异步确认链是 Reminder at-least-once 语义的保障机制。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| ScheduledJob | Entity | 有唯一 jobId，持久化，有生命周期（active → paused → cancelled） |
| Reminder | Entity | 有唯一 jobId，持久化，状态由 disposition 驱动（active → completed / cancelled） |
| FollowUp | Entity（短暂）| 有 jobId，但不持久化，进程重启后不恢复；生命周期极短（注册→触发→销毁） |
| nextFireTime | Value Object | 计算结果，随 Job 状态更新而重新计算 |

---

## 三、Key Data Fields（关键数据字段）

### Job 通用字段说明

| 字段 | 含义 |
|---|---|
| `jobId` | Job 的唯一标识，用于 cancel、disposition 关联 |
| `kind` | Job 变体：`'scheduled' \| 'reminder' \| 'follow-up'` |
| `sessionId` | 触发时关联的 session（可选，FollowUp 必填）|
| `nextFireTime` | 下次触发时间（毫秒 epoch），MinHeap 排序键 |
| `status` | 当前持久化状态（仅 ScheduledJob 和 Reminder 有持久化 status）|

### ScheduledJob 特有字段说明

| 字段 | 含义 |
|---|---|
| `cronExpr` | cron 表达式，如 `'0 9 * * *'`（每天 9 点）|
| `intervalMs` | 固定间隔毫秒数（与 cronExpr 二选一）|

每次触发后，scheduler 重新解析 cronExpr 或按 intervalMs 递增，计算新的 nextFireTime。

### Reminder 特有字段说明

| 字段 | 含义 |
|---|---|
| `fireAt` | 触发时刻（毫秒 epoch），一次性，触发后不重新计算 |

**status 转换说明（Reminder at-least-once 关键）：**

| 触发事件 | scheduler 写入 DB |
|---|---|
| scheduler 发出 `JobFired` 事件 | 不写，等待 disposition |
| heartbeat 回报 `accepted` | 写入 `status = completed` |
| heartbeat 回报 `started` | 写入 `status = completed` |
| heartbeat 回报 `deferred` | 不写，保持 `status = active` |
| heartbeat 回报 `rejected` | 不写，保持 `status = active`，记录 warning |

### SchedulerJob（持久化表结构语义，非完整 SQL 定义）

| 列 | 含义 |
|---|---|
| `job_id` | 主键 |
| `kind` | `'scheduled' \| 'reminder'`（FollowUp 不持久化）|
| `session_id` | 关联 session（可空）|
| `next_run_at` | nextFireTime，用于 DB 查询恢复 |
| `cron_expr` | 仅 ScheduledJob 有值 |
| `status` | `'active' \| 'paused' \| 'completed' \| 'cancelled'` |
| `payload` | JSON，存储 job 的业务参数 |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### ScheduledJob 生命周期

```
addScheduledJob() 注册
  → status: 'active'，写 DB，入 MinHeap
  ↓
[每次触发]
  → JobFired 发布
  → 重新计算 nextFireTime，更新 DB，重新入堆
  ↓
cancel(jobId) 或 status: 'paused'
  → 从 MinHeap 移除，更新 DB
```

### Reminder 生命周期

```
addReminder() 注册
  → status: 'active'，写 DB，入 MinHeap
  ↓
[触发时刻到达]
  → JobFired 发布（不写 DB）
  → 从 MinHeap 移除
  → 等待 SignalDisposition
       ├─ 'accepted' / 'started' → status: 'completed'，写 DB
       └─ 'deferred' / 'rejected' → status 保持 'active'，不写 DB
```

### FollowUp 生命周期

```
addFollowUp() 注册
  → 仅入 MinHeap，无 DB 操作
  ↓
[触发时刻到达]
  → JobFired 发布
  → 从 MinHeap 移除
  → [不关注 disposition，FollowUp 无需确认]
  ↓
进程重启
  → FollowUp 丢失，heartbeat 根据 run-ledger.interrupted 记录重新决策
```

### 数据归属

| 数据 | 创建 | 管理 | 说明 |
|---|---|---|---|
| scheduler_job 表记录 | scheduler（SchedulerStore）| scheduler | 唯一写入方；Reminder status 由 disposition 驱动 |
| MinHeap 内存状态 | scheduler（启动时从 DB 恢复）| scheduler（私有）| 不对外暴露，由 tick 循环维护 |
| nextFireTime 计算 | scheduler（jobs/ 模块内部）| scheduler | cron 解析和 interval 计算封装在 jobs/ 子目录 |
| FollowUp 内存状态 | scheduler | scheduler（临时）| 进程生命周期内有效，不持久化 |

---

## 五、文档自检

- [x] 三类 Job 的差异（持久化、触发后行为、at-least-once）清晰说明
- [x] Reminder at-least-once 的实现机制（disposition 协议）明确
- [x] FollowUp 不持久化的设计意图有说明
- [x] nextFireTime 作为 MinHeap 排序键的语义明确
