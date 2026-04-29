# stream-bridge 模块 data-model.md

本文档定义 `runtime/stream-bridge` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### 概念 1：Scope（事件域）

事件流的隔离单元。每个 scope 拥有独立的 RingBuffer、独立的 eventId 计数器、独立的订阅者集合。不同 scope 的 eventId 不可比较。

两种 scope：
- `'app'`：全局 daemon 级事件流，承载 runtime、permission、command、interaction、catalog 等 SDK 协议事件。
- `'run/<runId>'`：单次 Run 的流式输出和高频 delta。

`command.*`、`interaction.*`、`permission.*` 是事件名，不是 scope。bridge 不因为业务域增加新的 scope。

### 概念 2：StreamEvent（流事件）

stream-bridge 向订阅方 yield 的最小单元，有两种形态：

**普通事件**：包含业务数据的常规事件，由发布方通过 `publish()` 写入。

**stream.gap 事件**：当 RingBuffer 溢出导致历史事件被覆写时，bridge 主动生成的断层通知。`stream.gap` 是协议语义，不是错误，客户端收到后应拉取快照重建状态。它是订阅时合成的控制事件，不写入 RingBuffer，也不推进 scope 的 eventId 计数器。

### 概念 3：eventId（事件序号）

每个 scope 内的单调递增整数，由 bridge 分配。是 RingBuffer 的主键，也是断线重连的游标。客户端用 `lastEventId` 请求"从上次收到的 id 之后继续"。

eventId 是 per-scope 的，跨 scope 无意义。

### 概念 4：RingBuffer（环形缓冲）

每个 scope 的事件存储结构。容量固定，超出时覆写最旧条目。bridge 通过 `oldestId` 和 `latestId` 两个边界维护有效范围，供 gap 检测使用。

RingBuffer 是 bridge 的内部私有实现，外部不直接访问。

### 概念 5：ReplayPlan（回放计划）

`subscribe()` 时，bridge 根据 `lastEventId` 和 RingBuffer 边界计算的处理策略：
- `kind: 'replay'`：历史连续，从 `fromId` 回放
- `kind: 'gap'`：历史断层，返回 stream.gap 事件

ReplayPlan 是一次性计算结果，不对外暴露，仅在 `subscribe()` 内部使用。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| Scope（含 RingBuffer）| Entity | 有状态（eventId 计数器、Buffer 内容、订阅者集合），随 end() 销毁 |
| StreamEvent（普通）| Value Object | 不可变，yield 后由订阅方消费，无独立身份 |
| StreamEvent（stream.gap）| Value Object | bridge 订阅时合成，一次性传递给订阅方；不进入 RingBuffer |
| eventId | Value Object | 数字，无行为 |
| ReplayPlan | Value Object | 计算结果，一次性使用 |

---

## 三、Key Data Fields（关键数据字段）

### StreamEvent 普通形态字段说明

| 字段 | 含义 |
|---|---|
| `id` | scope 内的单调递增 eventId，订阅方用于断线重连游标；普通事件由 publish 分配 |
| `event` | 业务事件名称，如 `'run.updated'`、`'message.part.delta'`、`'runtime.updated'`、`'command.started'` |
| `data` | 业务数据，发布时已 JSON 序列化；订阅方接收的是已解析的 JsonValue |
| `runId` | scope 为 `run/<runId>` 时填充，方便订阅方关联 |

### StreamEvent stream.gap 形态的 data 字段说明

| 字段 | 含义 |
|---|---|
| `scope` | 发生断层的 scope 类型：`'app' \| 'run'` |
| `runId` | scope 为 run 时的 runId |
| `requestedLastEventId` | 客户端请求重连时携带的游标（上次收到的 id）|
| `oldestRetainedEventId` | RingBuffer 当前保留的最旧 eventId（gap 的起点）|
| `latestEventId` | RingBuffer 当前最新 eventId |
| `reason` | 断层原因：`'buffer-overflow'`（超出容量）或 `'bridge-restarted'`（进程重启）|

客户端可用 `requestedLastEventId` 和 `oldestRetainedEventId` 计算丢失事件数量，决定恢复策略。

`stream.gap` 自身的 `id` 使用 `latestEventId` 作为当前位置提示，但不代表 bridge 写入了一个新的业务事件。客户端收到后应拉取 snapshot，并以 snapshot 返回的最新游标继续订阅。

### RingBuffer 边界语义（概念层）

| 边界 | 含义 |
|---|---|
| `oldestId` | buffer 中最旧的有效 eventId（被覆写的条目已不可访问）|
| `latestId` | buffer 中最新的 eventId |
| gap 条件 | `lastEventId < oldestId - 1` 时判断为断层 |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### Scope 的生命周期

```
首次 publish(scope, ...) 或 subscribe(scope, ...)
  → scope 不存在时，bridge 自动创建 RingBuffer + eventId 计数器

[使用期间]
  → publish() 写入 RingBuffer，eventId 递增
  → subscribe() 返回 AsyncIterable 并注册订阅者

end(scope) 调用
  → 向所有订阅者发送 END_SENTINEL
  → 释放 RingBuffer 和 eventId 计数器
  → scope 销毁
```

**Scope 的归属控制**：
- `'app'` scope：daemon/app-events.ts 和 daemon/command-events.ts 发布，daemon 退出时 `end('app')`
- `'run/<runId>'` scope：RunWorker 发布，run 结束时 run-manager 调用 `end(scope)`

### eventId 的生命周期

- **创建**：scope 创建时从 0（或 1）开始
- **递增**：每次 `publish()` 分配一个新 id，不可回退
- **不持久化**：进程重启后 eventId 重置；客户端重连时若 lastEventId 不在新 buffer 范围内，bridge 发出 `stream.gap { reason: 'bridge-restarted' }`

### StreamEvent 的归属

| 阶段 | 归属 | 说明 |
|---|---|---|
| publish 时 | bridge 包装 | bridge 分配 id、强制校验序列化，包装为 StreamEvent |
| RingBuffer 存储期间 | bridge 内部 | 外部不直接访问 buffer 内容 |
| subscribe yield 后 | 订阅方 | 订阅方持有 StreamEvent 引用，bridge 不再管理 |

---

## 五、文档自检

- [x] Scope 作为事件隔离单元的定位清晰
- [x] stream.gap 作为协议语义（不是错误）的定位清晰
- [x] eventId per-scope 的约束明确
- [x] bridge 不生成快照的边界说明
- [x] ReplayPlan 是内部概念，不对外暴露
