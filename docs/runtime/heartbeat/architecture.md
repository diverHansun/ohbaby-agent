# heartbeat 模块 architecture.md

> **2026-07-11 架构修订（优先于下文旧方案）**：Heartbeat 不得是 global serve 进程里唯一的业务状态机。若未来 `/loop` 仍需要 Heartbeat，应将其建模为由 WorkspaceRuntime 管理的 session lane 状态机，身份至少是 `scopeKey + sessionId`；全局 Scheduler 经分发器找到目标 lane。一个 lane 的 active/paused/sleeping/blocked 和 deferred 状态不得影响其他项目或会话。当前 global-single-daemon 批次不实现 Heartbeat，下文“daemon 持有唯一 HeartbeatMachine”的描述为旧方案。

本文档描述 `runtime/heartbeat` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

heartbeat 采用 **HeartbeatMachine（状态机）+ DeferredQueue（优先级队列）** 两层结构。

```
┌──────────────────────────────────────────────────────────────────┐
│ HeartbeatMachine（状态机，公共接口）                               │
│                                                                  │
│ 职责：                                                           │
│ - 持有 agent 运行状态（active / paused / blocked / sleeping）    │
│ - 订阅 Scheduler.Event.JobFired 和 ChannelDispatcher.WakeRequested│
│ - 根据当前状态决策：立即创建 Run / 入队 / 忽略 / 判断提前唤醒     │
│ - 回报 Heartbeat.Event.SignalDisposition 给 scheduler            │
│ - 协调 agent 主动挂起（sleeping）和 follow-up 续跑               │
└──────────────────────────────────────────────────────────────────┘
                          │ 使用
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ DeferredQueue（优先级队列，私有）                                  │
│                                                                  │
│ 职责：                                                           │
│ - 按优先级（Reminder > ScheduledJob > FollowUp）维护队列          │
│ - 队列满时按优先级从低到高驱逐（FollowUp 先驱逐，Reminder 不驱逐） │
│ - enqueue() 返回 disposition（deferred / rejected）              │
│ - dequeue() 按优先级顺序弹出                                     │
└──────────────────────────────────────────────────────────────────┘
```

### 状态转换图

```
         用户暂停
active ──────────────► paused
  ▲                      │
  │ 用户恢复              │ 用户恢复（处理 deferred queue）
  └──────────────────────┘

         agent 请求 sleeping N 秒
active ──────────────────────────► sleeping
  ▲                                    │
  │ follow-up 触发 / 提前唤醒           │
  └────────────────────────────────────┘

         blocked 条件满足
blocked ─────────────────────────► active
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **HeartbeatMachine** | 状态机主体：状态转换、信号决策、disposition 回报 |
| **DeferredQueue** | 优先级队列：驱逐策略、at-least-once Reminder 语义（私有） |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. State 模式（状态机）

HeartbeatMachine 的核心是一个显式状态机，当前状态决定信号的处理方式。

**使用理由**：
- agent 的运行状态（active / paused / blocked / sleeping）对信号处理有完全不同的语义，状态机使这些分支显式化，避免散落的 if/else
- 状态转换有明确的触发条件（用户暂停、follow-up 触发、blocked 条件满足），状态机使转换可追踪

**实现方式**：使用简单的枚举 + switch，不引入状态机框架（XState 等）。当前状态数量少（4 个），框架引入的复杂度超过收益。

### 2. DeferredQueue 独立封装可靠性语义

DeferredQueue 不是普通数组，它封装了优先级驱逐策略和 Reminder at-least-once 语义。

**独立的理由**：
- 驱逐策略（先驱逐 FollowUp，再驱逐 ScheduledJob，Reminder 不驱逐）有自己的不变量，值得独立单测
- `enqueue()` 返回 disposition（`deferred` / `rejected`），这个语义与 HeartbeatMachine 的状态决策解耦
- HeartbeatMachine 只需要调用 `queue.enqueue(signal)` 并处理返回的 disposition，不需要知道驱逐细节

**不内联在 machine.ts 的理由**：如果内联，machine.ts 会同时包含状态机逻辑和队列驱逐逻辑，两个不同的关注点混在一起，降低可读性和可测试性。

### 3. disposition 回报作为协议语义

HeartbeatMachine 在处理每条信号后，通过 Bus 发布 `Heartbeat.Event.SignalDisposition`，携带 `accepted / deferred / rejected / started`。

**使用理由**：
- Scheduler 需要知道 Reminder 是否被接受，才能决定何时写 `completed`
- Bus 事件是进程内通信，不引入额外的接口耦合

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/heartbeat/
├── index.ts              # 公共接口：导出 HeartbeatMachine 类和 AgentState 类型
├── machine.ts            # HeartbeatMachine 类：状态机主体
├── deferred-queue.ts     # DeferredQueue 类：优先级队列 + 驱逐策略（私有）
├── types.ts              # AgentState、WakeSignal、SignalKind、Disposition 类型
└── __tests__/
    ├── machine.test.ts
    └── deferred-queue.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 导出 HeartbeatMachine 和 AgentState 类型；DeferredQueue 不对外暴露 |
| `machine.ts` | 状态机 | 状态转换、信号决策（active/paused/sleeping/blocked 分支）、disposition 回报 |
| `deferred-queue.ts` | 私有工具 | 优先级队列实现：enqueue（含驱逐）、dequeue（按优先级）、isEmpty |
| `types.ts` | 类型定义 | AgentState 枚举；WakeSignal（signalId、jobId、kind、triggerSource、sessionId）；Disposition 联合类型 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`HeartbeatMachine` 的 `getState` / `setState` / `start` / `stop` 方法；`AgentState` 枚举
- **内部实现**：DeferredQueue 的驱逐算法；disposition 回报的 Bus 事件名；sleeping 状态的唤醒时间记录

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. DeferredQueue 只在 paused 状态下使用

当前设计中，deferred queue 只在 `paused` 状态下接收信号。`sleeping` 状态下的信号处理（是否提前唤醒）由 HeartbeatMachine 直接判断，不入队。

**代价**：如果未来需要在 `sleeping` 状态下也缓冲信号（而不是立即判断是否提前唤醒），需要扩展 DeferredQueue 的使用场景。当前设计是最小化的，符合 YAGNI。

### 2. Reminder at-least-once 语义的代价

Reminder 不会因队列满而被静默丢弃，但如果队列中全为 Reminder 且新 Reminder 到达，会 `rejected` 并记录警告。`rejected` 的 Reminder 保持 `active` 状态，不自动重试。

**代价**：`rejected` 的 Reminder 需要运维/用户介入（查看警告日志，手动重试或清理队列）。这是有意的取舍：自动重试会引入重试风暴风险，当前阶段不实现。

### 3. 放弃的方案：heartbeat 直接轮询 scheduler 状态

可以让 heartbeat 定期轮询 scheduler 的 job 列表，判断是否有到期 job 需要执行。

**放弃理由**：轮询引入了 CPU 消耗和延迟，且 heartbeat 不应知道 scheduler 的内部状态。事件驱动（Bus 订阅）是更干净的解耦方式：scheduler 产生信号，heartbeat 消费信号，两者通过 Bus 解耦。
