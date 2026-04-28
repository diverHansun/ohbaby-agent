# heartbeat 模块 test.md

本文档说明如何验证 `runtime/heartbeat` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- HeartbeatMachine 的 4 个状态（active / paused / sleeping / blocked）在收到 WakeSignal 时的决策路径
- DeferredQueue 的入队、满队拒绝、paused → active 时的 drain 顺序
- sleeping 状态的提前唤醒门槛判断（priority 和 kind）
- SignalDisposition 发布（accepted / deferred / rejected）的触发条件
- AgentState 转换的正确性（setState 的各路径）
- onAgentSleepRequest：FollowUp 注册 + 进入 sleeping 状态

**不覆盖**：
- runManager.create() 内部的并发仲裁逻辑（run-manager 侧的职责）
- scheduler 的 JobFired 发布逻辑（scheduler 侧的职责）
- Reminder DB 状态的写入（scheduler + SchedulerStore 侧的职责）
- DeferredQueue drain 期间 create() 调用的实际 Run 创建结果

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：active 状态下的信号处理

| 场景 | 预期结果 |
|------|---------|
| 收到 JobFired (kind='reminder')，state=active | mapSignalToTrigger → triggerSource='scheduler'；调用 runManager.create()；发布 disposition='accepted' |
| 收到 JobFired (kind='scheduled')，state=active | 同上 |
| 收到 JobFired (kind='follow-up')，state=active | triggerSource='follow-up'；调用 create()；发布 accepted |
| 收到 WakeRequested (kind='channel')，state=active | triggerSource='channel'；调用 create()；不发布 SignalDisposition |

### 场景组 2：paused 状态下的信号缓冲

| 场景 | 预期结果 |
|------|---------|
| 收到信号，state=paused，队列未满 | 信号入 DeferredQueue；发布 disposition='deferred' |
| 收到信号，state=paused，队列已满且无法驱逐 | 信号不入队；发布 disposition='rejected' |
| 队列有信号时 setState('active') | drain 按优先级（Reminder > ScheduledJob > FollowUp）顺序调用 runManager.create()；每条 scheduler 信号发布 accepted |

### 场景组 3：sleeping 状态的唤醒判断

| 场景 | 预期结果 |
|------|---------|
| 收到 kind='reminder'，state=sleeping | 满足唤醒条件；setState('active')；create()；accepted |
| 收到 priority 足够的 scheduled，state=sleeping | 提前唤醒；create()；accepted |
| 收到 priority 不足的信号，state=sleeping | 不唤醒；发布 rejected |

### 场景组 4：blocked 状态

| 场景 | 预期结果 |
|------|---------|
| 收到任何 scheduler 信号，state=blocked | 不调用 create()；发布 rejected |
| 收到 WakeRequested，state=blocked | 不调用 create()；不发布 SignalDisposition |

### 场景组 5：sleeping 注册

| 场景 | 预期结果 |
|------|---------|
| onAgentSleepRequest({ durationMs, sessionId }) | 调用 scheduler.addFollowUp({ fireAt: now+durationMs, sessionId })；state 变为 sleeping |

---

## 三、Integration Points（集成点测试）

### 集成点 1：heartbeat → runManager.create()（轻集成）

**验证重点**：heartbeat 在 active 状态下正确构造 create() 的参数（triggerSource、sessionId）并调用

**方式**：在单元测试中使用 fake RunManager（记录调用参数）；断言 triggerSource 和 sessionId 与 WakeSignal 一致

### 集成点 2：heartbeat → scheduler.addFollowUp()（轻集成）

**验证重点**：sleeping 注册时 addFollowUp 的参数正确（fireAt = now + durationMs）

**方式**：fake Scheduler，断言调用参数

### 集成点 3：heartbeat → Bus 发布 SignalDisposition（轻集成）

**验证重点**：各决策路径发布正确的 disposition 值；channel 信号不发布 SignalDisposition

**方式**：fake Bus，检查发布的事件类型和字段

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）

**测试对象**：HeartbeatMachine（状态机核心）、DeferredQueue（队列逻辑）、mapSignalToTrigger（映射函数）

**Mock 范围**（遵循 `writing-guide.md` unit 规则，mock 所有直接依赖）：
- `runManager` → fake RunManager（记录 create() 调用，可配置返回值）
- `scheduler` → fake Scheduler（记录 addFollowUp() 调用）
- `Bus` → fake Bus（记录发布的事件，可手动 emit 订阅事件）

**不 mock**：HeartbeatMachine 自身、DeferredQueue 自身

**组织方式**：
- `TestHeartbeatMachine_ActiveState`：active 状态下各 signal kind 的分支
- `TestHeartbeatMachine_PausedState`：入队、满队、drain 顺序
- `TestHeartbeatMachine_SleepingState`：唤醒门槛、FollowUp 触发
- `TestHeartbeatMachine_BlockedState`：reject 所有信号
- `TestDeferredQueue`：容量上限、优先级排序、drain 幂等性

### 关注点：状态机分支覆盖

每个（state × signal_kind）组合是一个独立的测试场景。状态机的价值在于分支正确，不在于共享代码路径，不应为了减少测试数量而合并分支场景。

### 关注点：SignalDisposition 的发布时机

disposition 的发布必须在 runManager.create() 调用之后（不是之前），否则 scheduler 会在 Run 实际未创建时认为 Reminder 已完成。测试应验证调用顺序，而不仅仅是调用次数。
