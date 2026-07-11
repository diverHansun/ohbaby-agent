# heartbeat 模块 non-functional.md

> **2026-07-11 非功能约束修订（优先于下文旧方案）**：第一优先级增加“lane 隔离”：A 项目/session 的 paused、blocked、sleeping、队列溢出或创建失败，不得改变 B 项目/session 的状态、队列或 disposition。日志和指标必须包含 `scopeKey + sessionId + jobId`。同一 job 的忙碌补偿最多合并一次，避免长期运行 session 造成无界积压。当前批次不实现 Heartbeat。

本文档定义 `runtime/heartbeat` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，当约束冲突时以此为准：

1. **Reminder 不丢失语义**（首要）：scheduler 发出的 Reminder 信号在 heartbeat 处理后必须有明确的 disposition 回报（accepted / deferred / rejected），不允许静默丢弃。disposition 驱动 scheduler 侧的 Reminder 完成状态，是跨模块数据一致性的基础。

2. **状态转换的原子性**：AgentState 的变更（如 paused → active）和随之发生的操作（DeferredQueue drain）必须作为一个整体被感知，不允许外部在转换中途观察到不一致的中间状态。

3. **事件处理的顺序性**：同一时刻只处理一个 WakeSignal，不并发处理多个信号（状态机不是线程安全的并发组件，而是串行决策者）。

---

## 二、Operational Constraints（运行约束）

### DeferredQueue 容量

- DeferredQueue 必须有明确的容量上限，不允许无限增长
- 容量上限应在配置中显式声明（建议与 scheduler 的 Reminder 吞吐量匹配）
- 队列满时必须执行优先级驱逐：新信号到达时，先尝试驱逐已有的低优先级条目（FollowUp → ScheduledJob），为高优先级信号腾出空间
- Reminder 绝不被静默驱逐；如果队列中没有可驱逐的低优先级条目，则新 Reminder 返回 `rejected` disposition 并记录 warning

### sleeping 状态的唤醒门槛

- priority 门槛值需要在实现阶段显式定义（不使用隐含的"足够高"）
- 当前约定：kind='reminder' 始终满足唤醒条件（无论 priority 值）；ScheduledJob（priority=2）和 FollowUp（priority=1）需要满足 priority ≥ threshold
- threshold 的默认值应在 HeartbeatMachine 配置中声明

### 状态机执行模型

- HeartbeatMachine 是事件驱动的单线程状态机；Bus 事件的处理应为串行（一次处理一个）
- Bus 订阅回调不应阻塞（不做同步 DB 写入）；dispatch 到 runManager.create() 是异步的，不等待 Run 完成

### 进程重启后的状态恢复

- heartbeat 重启后进入 active 状态（默认初始态），不恢复崩溃前的状态
- DeferredQueue 不持久化，重启后清空；paused 期间缓冲的信号丢失是已知边界
- sleeping 期间的 FollowUp 不持久化，重启后不恢复；run-manager 的 markInterrupted 负责处理遗留 Run

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- Reminder 收到后未回报任何 disposition：scheduler 无法驱动 Reminder 完成，导致 Reminder 永久停留在 active 状态，不可接受
- AgentState 被外部直接修改（绕过 setState()）：破坏状态机不变量，不可接受
- 同时处理两个 WakeSignal 导致并发状态修改：违反串行处理约定，不可接受

### 可接受的失败

- runManager.create() 调用失败：heartbeat 记录日志，发布 rejected disposition，不向 Bus 传播异常
- DeferredQueue drain 过程中单条信号的 create() 失败：跳过该条，继续 drain 后续信号；记录日志
- Bus 回调执行异常：记录错误并继续处理后续事件，不允许异常逃逸导致 HeartbeatMachine 停止；已发布的进程内信号不做可靠重放

### 可观测性

- AgentState 每次转换应记录结构化日志（from、to、触发原因）
- 每个 WakeSignal 的处理结果应记录（signalId、kind、state、disposition）
- DeferredQueue 的 enqueue/dequeue 操作应记录（当前队列深度），便于分析 paused 状态的积压情况
- sleeping → active 的提前唤醒（非 FollowUp 触发）应记录（触发原因，便于分析非预期唤醒）

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：DeferredQueue 持久化

paused 期间缓冲的信号在进程重启后丢失。持久化 DeferredQueue 需要额外的 DB 表和恢复逻辑，复杂度不合算。当前阶段 paused 状态预期是短暂的人为操作（如用户暂停 agent），不是长期状态，丢失风险可接受。

### 当前不追求：优先级穿透执行（paused 状态）

paused 状态下，所有可缓冲信号进入 DeferredQueue，高优先级信号不会绕过队列直接执行。这简化了 paused 语义（paused 就是完全暂停，不存在"紧急信号仍可穿透"的情况）。优先级只用于队列内部的排序和溢出驱逐，不用于打破 paused 状态。未来若需要支持紧急唤醒穿透，需要在 paused 分支增加优先级判断。

### 当前不追求：睡眠状态的崩溃恢复

sleeping 状态的续跑计划（FollowUp）进程重启后不恢复。重启后 run-manager 的 markInterrupted 处理遗留 Run，但不会自动注册新的 FollowUp。是否续跑由 heartbeat 的上层业务逻辑决定（如用户手动触发），不由 heartbeat 自动恢复。

### 当前不追求：blocked 状态的自动解除

blocked 状态只能由 daemon/supervisor 调用 setState('active') 解除，heartbeat 不自行判断何时退出 blocked。blocked 的条件和解除策略属于业务层决策，超出 heartbeat 职责范围。
