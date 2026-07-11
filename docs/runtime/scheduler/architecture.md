# scheduler 模块 architecture.md

> **2026-07-11 架构修订（优先于下文旧方案）**：本模块尚未在 global-single-daemon 批次实现。未来只允许一个进程级 Scheduler 负责时间计算和 durable job 恢复；每个 job 必须绑定 `scopeKey + sessionId`，到期后经调度分发器调用 `InstanceStore.load(scopeKey)`，再进入目标 session 的执行通道。Scheduler 不持有机器级 Heartbeat，也不直接持有某个 workspace 的 RunManager。目标 session 忙碌时，同一 job 最多合并一个 pending trigger，不能无限排队。下文 `Scheduler → 全局 Heartbeat → RunManager` 与“机器级状态统一阻塞”的描述均视为旧方案，不再作为实现依据。

本文档描述 `runtime/scheduler` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

scheduler 采用 **Scheduler（调度核心）+ MinHeap（数据结构）+ SchedulerStore（持久化）** 三层结构。

```
┌──────────────────────────────────────────────────────────────────┐
│ Scheduler（公共接口，调度核心）                                    │
│                                                                  │
│ 职责：                                                           │
│ - 提供 addScheduledJob / addReminder / addFollowUp / cancel 接口 │
│ - 管理 tick 循环：计算堆顶 nextFireTime，调用 setTimeout 等待     │
│ - tick 到达时弹出所有到期 job，依次触发                           │
│ - 周期性 job 重新计算 nextFireTime 并入堆；一次性 job 移除        │
│ - 触发时发出 Scheduler.Event.JobFired Bus 事件                   │
│ - 订阅 Heartbeat.Event.SignalDisposition，驱动 Reminder completed │
└──────────────────────────────────────────────────────────────────┘
          │ 使用                          │ 使用
          ▼                               ▼
┌──────────────────────┐     ┌────────────────────────────┐
│ MinHeap<HeapItem>    │     │ SchedulerStore              │
│（私有工具）           │     │（持久化层）                  │
│                      │     │                            │
│ 职责：               │     │ 职责：                     │
│ - 按 nextFireTime    │     │ - 读写 scheduler_job 表     │
│   维护最小堆          │     │ - 仅处理 ScheduledJob 和    │
│ - O(log n) 增删改    │     │   Reminder（FollowUp 不持久化）│
│ - 支持按 id 删除      │     │ - 启动时恢复持久化 job 入堆  │
└──────────────────────┘     └────────────────────────────┘
```

### 三类 Job 的处理差异

| Job 类型 | 堆中存在 | 持久化 | 触发后行为 |
|---|---|---|---|
| ScheduledJob | 是 | 是（scheduler_job 表） | 重新计算 nextFireTime 入堆 |
| Reminder | 是 | 是（scheduler_job 表） | 移除；completed 由 disposition 驱动 |
| FollowUp | 是 | 否（纯内存） | 移除 |

### 主要组件

| 组件 | 职责 |
|---|---|
| **Scheduler** | 调度核心：tick 循环、job 管理、Bus 事件发布/订阅 |
| **MinHeap** | 私有数据结构：按 nextFireTime 排序的最小堆 |
| **SchedulerStore** | 持久化层：scheduler_job 表的 Repository |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 事件驱动调度（setTimeout + MinHeap）

Scheduler 不使用定时轮询，而是计算堆顶 job 的 `nextFireTime` 与当前时间的差值，精确 `setTimeout` 到下一个触发点。

**使用理由**：
- 空闲时零 CPU 消耗（无 job 时不设 setTimeout）
- 触发精度由系统 setTimeout 保证，不受轮询间隔影响
- 与 hermes-agent 的 60 秒轮询方案形成对比，避免高频空转

**代价**：setTimeout 在 Node.js 中有最小精度限制（约 1ms），对于毫秒级精度需求不适用。但 scheduler 的触发场景（cron 任务、提醒）精度要求在秒级，这个限制不影响实际使用。

### 2. MinHeap 作为私有内部工具（轻量泛型）

MinHeap 独立为 `heap.ts`，使用轻量内部泛型约束：

```typescript
interface HeapItem { nextFireTime: number }
class MinHeap<T extends HeapItem> { ... }
```

**使用理由**：
- 最小堆有自己的不变量（堆序性质），值得独立单测
- 放在 scheduler.ts 里会把 tick 调度、job 语义、堆操作混在一起，降低可读性
- 泛型约束极窄（只要求 `nextFireTime`），不算过度设计

**不提升为公共工具的理由**：MinHeap 目前只有 scheduler 使用，提升为 `utils/heap` 是过早抽象。先作为 scheduler 私有工具，有第二个使用方时再提升。

### 3. SchedulerStore 只持久化用户承诺类 Job

SchedulerStore 只处理 ScheduledJob 和 Reminder，不处理 FollowUp。

**使用理由**：
- FollowUp 是 agent loop 的内部续跑等待，属于进程内部短期 wakeup，重启后由 run-ledger 的 interrupted 记录 + heartbeat 重新决策
- 持久化 FollowUp 会引入"重启后是否自动续跑"的复杂语义，当前阶段 YAGNI

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/scheduler/
├── index.ts              # 公共接口：导出 Scheduler 类和 Job 类型
├── scheduler.ts          # Scheduler 类：tick 循环、job 管理、Bus 事件
├── heap.ts               # MinHeap<T extends HeapItem>（私有工具）
├── store.ts              # SchedulerStore：scheduler_job 表 Repository
├── jobs/
│   ├── scheduled-job.ts  # ScheduledJob 类型 + nextFireTime 计算（cron / interval）
│   ├── reminder.ts       # Reminder 类型
│   └── follow-up.ts      # FollowUp 类型（纯内存，无持久化）
├── types.ts              # Job 联合类型、HeapItem、SchedulerEvent 类型
└── __tests__/
    ├── scheduler.test.ts
    ├── heap.test.ts
    ├── store.test.ts
    └── jobs/
        └── scheduled-job.test.ts  # cron 计算逻辑单测
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 导出 Scheduler 和 Job 类型；heap.ts 和 store.ts 不对外暴露 |
| `scheduler.ts` | 调度核心 | tick 循环、MinHeap 操作、Bus 事件发布/订阅、Reminder disposition 处理 |
| `heap.ts` | 私有工具 | MinHeap 实现，独立可测 |
| `store.ts` | 持久化层 | ScheduledJob + Reminder 的 DB 读写；启动时恢复 job 入堆 |
| `jobs/` | 类型 + 计算 | 每个文件定义 job 类型和相关计算（如 cron nextFireTime） |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`Scheduler` 的 `addScheduledJob` / `addReminder` / `addFollowUp` / `cancel` / `start` / `stop` 方法；Job 类型
- **内部实现**：MinHeap 实现；tick 循环逻辑；SchedulerStore 的 SQL 查询

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. Reminder completed 由 disposition 驱动，不在触发时写入

Scheduler 在发出 `JobFired` Bus 事件后不立即将 Reminder 标为 `completed`，而是等待 heartbeat 回报 `accepted` 或 `started` disposition 后才写入。

**代价**：Scheduler 需要维护"已触发但未确认"的 Reminder 状态，并订阅 `Heartbeat.Event.SignalDisposition` Bus 事件。这引入了 scheduler 与 heartbeat 之间的异步协议复杂度。但这是正确的语义：触发信号发出不等于承诺兑现。

### 2. 进程重启后 FollowUp 不自动恢复

FollowUp 是纯内存 job，进程重启后丢失。重启后由 run-ledger 的 `interrupted` 记录 + heartbeat 或用户交互重新决策是否续跑。

**代价**：agent 主动挂起后如果进程崩溃，续跑等待会丢失，需要用户或 heartbeat 重新触发。这是有意的取舍：FollowUp 的语义是"短期内续跑"，跨进程重启的续跑语义更复杂，当前阶段不支持。

### 3. 放弃的方案：使用 node-cron 或 agenda 等第三方调度库

可以使用成熟的调度库替代自实现的 MinHeap + setTimeout 方案。

**放弃理由**：第三方调度库通常假设 DB 持久化（如 agenda 依赖 MongoDB），或不支持 FollowUp 这类纯内存短期 wakeup 的混合场景。自实现的 MinHeap 方案代码量小（约 100 行），完全可控，且与 ohbaby 的三类 job 语义精确匹配。
