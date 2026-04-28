# heartbeat 模块 data-model.md

本文档定义 `runtime/heartbeat` 模块的核心概念与数据模型，统一认知语言，不冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1：AgentState（agent 运行状态）

heartbeat 持有的 agent 状态，决定"当前是否可以接受新 Run"。它不是 UI 展示状态，而是对 WakeSignal 处理语义的权威裁定。

| 状态 | 含义 |
|---|---|
| `active` | 就绪，收到 WakeSignal 直接创建 Run |
| `paused` | 用户主动暂停，信号入 DeferredQueue 等待 |
| `sleeping` | agent 主动挂起等待续跑，信号按优先级判断是否提前唤醒 |
| `blocked` | 外部条件未满足，信号被忽略直到条件解除 |

四个状态的核心区别是**对 WakeSignal 的处理方式**，与 agent 的业务逻辑无关。

### 概念 2：WakeSignal（唤醒信号）

heartbeat 内部对所有触发信号的统一表示。无论来源是 scheduler 的 `JobFired` 还是 ChannelDispatcher 的 `WakeRequested`，到达 HeartbeatMachine 时均转换为 WakeSignal。

WakeSignal 是一次性值对象：创建后交由状态机决策，处理完毕即释放，不持久化。

### 概念 3：DeferredQueue（延迟队列）

paused 状态下的信号缓冲区，由 HeartbeatMachine 私有持有。

DeferredQueue 不是普通队列，封装了两个独立的不变量：
1. **优先级排序**：出队顺序为 Reminder > ScheduledJob > FollowUp，与入队顺序无关
2. **Reminder at-least-once 语义**：队列满时优先驱逐低优先级条目，Reminder 不会因队列满而静默丢弃

DeferredQueue 只在 `paused` 状态下接收信号。`sleeping` 状态下的信号处理由 HeartbeatMachine 直接判断，不走 DeferredQueue。

### 概念 4：Disposition（处置结果）

heartbeat 对每条 WakeSignal 的处置结果，通过 Bus 事件回报给 scheduler。这是一个协议语义，而非简单返回值。scheduler 依赖 Disposition 来决定 Reminder 是否已被兑现（是否可以写 `completed`）。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| `HeartbeatMachine` | Entity | 持有 AgentState，有生命周期（start/stop），进程内唯一实例 |
| `DeferredQueue` | Entity | 持有队列状态，由 HeartbeatMachine 私有创建和销毁 |
| `AgentState` | Value Object（枚举）| 无标识，仅有语义，可直接比较和替换 |
| `WakeSignal` | Value Object | 不可变，一次性使用，无标识 |
| `Disposition` | Value Object（联合类型）| 处置结果，随 Bus 事件传递后即释放 |

---

## 三、Key Data Fields（关键数据字段）

### WakeSignal 字段说明

| 字段 | 含义 |
|---|---|
| `signalId` | 唤醒信号 ID；scheduler 信号复用 jobId，channel 信号可使用 message/wake id |
| `jobId` | 对应 scheduler 侧的 jobId，用于 disposition 回报时关联；channel 信号可为空 |
| `kind` | 信号类型：`'reminder' \| 'scheduled' \| 'follow-up' \| 'channel'`，影响优先级和驱逐策略 |
| `triggerSource` | 传给 run-manager 的触发源：scheduler 的 `scheduled/reminder` 统一映射为 `scheduler`，follow-up 映射为 `follow-up`，channel 映射为 `channel` |
| `sessionId` | 目标 session；ChannelDispatcher 触发时必有，scheduler 触发时可选 |
| `priority` | 优先级数值：Reminder/Channel=3, ScheduledJob=2, FollowUp=1；sleeping 状态下唤醒判断依赖此字段 |

**字段说明补充**：
- `jobId`：heartbeat 不关心 job 的业务内容，只用 jobId 做 scheduler disposition 关联
- `sessionId`：heartbeat 将其透传给 runManager.create()，不做 session 查找或创建

### Disposition 枚举说明

```
'accepted' → 已接受，run-manager 创建了 pending RunRecord（Reminder 可写 completed）
'started'  → 已启动，run-manager 确认 Run 实际启动（Reminder 可写 completed）
'deferred' → 已入队，等待 paused→active 后处理（Reminder 保持 active）
'rejected' → 当前无法接收且未入队（队列满无法驱逐、blocked、sleeping 低优先级等）；Reminder 保持 active，记录 warning
```

### DeferredQueue 驱逐优先级

| 驱逐对象 | 触发条件 | 结果 |
|---|---|---|
| FollowUp | 队列满时优先驱逐 | 被静默移除 |
| ScheduledJob | FollowUp 已全部驱逐后仍满 | 被静默移除 |
| Reminder | 队列满且无低优先级可驱逐 | 拒绝，disposition: `rejected`，记录 warning |

Reminder 绝不被静默驱逐。

---

## 四、Lifecycle & Ownership（生命周期与归属）

### AgentState 状态转换

```
进程启动
  └─ HeartbeatMachine.start() → 初始状态: active

active ──[用户暂停]──────────────► paused
paused ──[用户恢复]──────────────► active（drain DeferredQueue）

active ──[agent 请求 sleeping]───► sleeping
sleeping ──[follow-up 触发 / 提前唤醒]──► active

blocked ──[blocked 条件满足]─────► active

进程退出
  └─ HeartbeatMachine.stop() → 取消 Bus 订阅
```

**持久化说明**：AgentState 不持久化。进程重启后初始状态为 `active`，由 run-ledger 的 `interrupted` 记录驱动续跑决策，不恢复之前的 `sleeping` / `blocked` 状态。

### DeferredQueue 生命周期

```
创建：随 HeartbeatMachine 实例创建（私有成员）
活跃：仅在 paused 状态下接收新信号
消费：paused → active 转换时，按优先级 drain
销毁：随 HeartbeatMachine 实例销毁；队列中未处理的信号丢失（不持久化）
```

### 数据归属

| 数据 | 归属 | 外部访问方式 |
|---|---|---|
| `AgentState` | HeartbeatMachine（独占写入）| `getState()`（只读）/ `setState()`（触发转换）|
| `DeferredQueue` | HeartbeatMachine（私有）| 不对外暴露 |
| `WakeSignal` | Bus 产生，heartbeat 短暂持有 | 处理完毕即释放 |
| `SignalDisposition` | heartbeat 产生 → Bus → scheduler 消费 | 一次性，不缓存 |

---

## 五、文档自检

- [x] 四种 AgentState 的语义差异清晰说明
- [x] DeferredQueue 的两个不变量（优先级排序 + Reminder at-least-once）明确
- [x] Disposition 作为协议语义（而非返回值）的定位清晰
- [x] WakeSignal 作为一次性值对象、不持久化的特性说明
