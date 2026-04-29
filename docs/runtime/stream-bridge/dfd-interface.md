# stream-bridge 模块 dfd-interface.md

本文档描述 `runtime/stream-bridge` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

stream-bridge 是 runtime 的事件传输层，连接"事件发布方"（runtime 内部）与"事件订阅方"（SDK/TUI/Web clients）。

| 方向 | 外部模块 | 交互方式 |
|---|---|---|
| 接收发布 | `runtime/run-manager` RunWorker | 调用 `publish(scope, event, data)` 发布 run.* 事件 |
| 接收发布 | `runtime/daemon` app-events.ts | 调用 `publish('app', event, data)` 发布通用 app scope 事件 |
| 接收发布 | `runtime/daemon` command-events.ts | 调用 `publish('app', event, data)` 发布 command.* / interaction.* 事件 |
| 提供订阅 | SDK clients / TUI / Web | 调用 `subscribe(scope, lastEventId?)` 获取 AsyncIterable |
| 控制关闭 | `runtime/run-manager`（run 结束时）| 调用 `end(scope)` 关闭指定 scope |
| 控制关闭 | `runtime/daemon`（daemon 退出时）| 调用 `end('app')` |

**讨论范围**：本文档关注 StreamBridge 公共接口的数据流语义，不涉及 RingBuffer 的环形缓冲实现细节。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：事件发布（publish）

```
发布方（RunWorker / app-events.ts）
  → publish(scope, eventName, data)
  ↓
stream-bridge 分配单调递增 eventId（per scope）
  ↓
强制验证 data 可 JSON 序列化（Fail Fast）
  ↓
写入 scope 对应的 RingBuffer（覆写最旧条目当 buffer 满时）
  ↓
通知所有正在 subscribe 的 AsyncIterable 消费者
  ↓
消费者从 AsyncIterable 迭代到新事件
```

### 流程 2：首次订阅（subscribe，无 lastEventId）

```
客户端调用 subscribe(scope)  ← 无 lastEventId，全新订阅
  ↓
stream-bridge 为此客户端创建 AsyncIterable
  ↓
从 latestId + 1 开始推送新事件（不回放历史）
  ↓
每隔一段时间发送 HEARTBEAT_SENTINEL（保持连接活跃）
  ↓
[持续 yield 新事件，直到 end(scope) 被调用]
  ↓
收到 END_SENTINEL → AsyncIterable 完成（done: true）
```

### 流程 3：断线重连（subscribe，携带 lastEventId）

```
客户端断线重连，携带上次收到的 lastEventId
  → subscribe(scope, lastEventId)
  ↓
getReplayPlan(scope, lastEventId) 决策：

  [连续情况：lastEventId >= buffer.oldestId - 1]
    → replay: 从 lastEventId + 1 开始回放 buffer 中的历史事件
    → 回放完成后切换为推送模式（推送新事件）

  [断层情况：lastEventId < buffer.oldestId - 1]
    → 立即发出 stream.gap 事件：
      {
        id: buffer.latestId,
        event: 'stream.gap',
        data: {
          scope, runId?,
          requestedLastEventId: lastEventId,
          oldestRetainedEventId: buffer.oldestId,
          latestEventId: buffer.latestId,
          reason: 'buffer-overflow'
        }
      }
      [stream.gap 为合成控制事件，不写入 RingBuffer，不推进 eventId]
    → 之后切换为推送模式（stream.gap 后发送最新事件）
    → 客户端收到 stream.gap 后应另行调用 getSnapshot() 重建状态
      [注意：快照生成由 interfaces/server 负责，不在 bridge 内]
```

### 流程 4：scope 结束（end）

```
run 结束 → runManager 调用 end(scope)
  ↓
stream-bridge 发送 END_SENTINEL 给所有该 scope 的订阅者
  ↓
所有该 scope 的 AsyncIterable 完成（done: true）
  ↓
释放该 scope 的 RingBuffer 内存
```

---

## 三、Interface Definition（接口定义）

### 接口 1：publish(scope, event, data)

**语义**：向指定 scope 发布一个业务事件。scope 表达传输路由，event 表达协议语义。

- **输入**：`scope`（`'app'` 或 `'run/<runId>'`）、`event`（事件名称字符串，如 `runtime.updated`、`command.started`、`interaction.requested`）、`data`（必须可 JSON 序列化）
- **输出**：分配的 `eventId`（number）
- **同步/异步**：同步（写入 buffer + 通知订阅者是内存操作）
- **约束**：`data` 必须可序列化，否则抛出异常（不静默降级）

### 接口 2：subscribe(scope, lastEventId?)

**语义**：订阅指定 scope 的事件流，返回 AsyncIterable，支持断线重连。

- **输入**：`scope`、可选 `lastEventId`（断线重连时传入）
- **输出**：`AsyncIterable<StreamEvent>`
- **行为**：
  - 无 `lastEventId`：仅推送新事件
  - 有 `lastEventId` 且连续：回放历史 + 推送新事件
  - 有 `lastEventId` 且断层：首先 yield 一个 `stream.gap` 事件，再推送新事件
- **同步/异步**：返回同步，迭代异步

**注意**：bridge 不生成快照，`stream.gap` 是信号，客户端应另行获取快照。

### 接口 3：end(scope)

**语义**：关闭指定 scope，终止该 scope 的所有 AsyncIterable。

- **输入**：`scope`
- **效果**：所有订阅该 scope 的客户端收到 END_SENTINEL → AsyncIterable done

### 内置哨兵（仅 AsyncIterable 内部传递，不序列化）

| 哨兵 | 含义 |
|---|---|
| `HEARTBEAT_SENTINEL` | 定时发送，保持客户端连接活跃（不写入 RingBuffer）|
| `END_SENTINEL` | scope 结束，AsyncIterable 完成 |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建 | 所有者 | 责任边界 |
|---|---|---|---|
| `eventId` | stream-bridge（per scope 分配）| stream-bridge | 单调递增不变量由 bridge 保证；不对外修改 |
| `StreamEvent`（普通事件）| stream-bridge（包装发布方数据）| 订阅方（消费后 yield）| bridge 负责 id 分配和序列化；数据来自发布方 |
| `StreamEvent`（stream.gap）| stream-bridge（内部生成）| 订阅方（消费后 yield）| bridge 唯一生产者；快照生成不在此 |
| `RingBuffer`（每个 scope）| stream-bridge 内部 | stream-bridge | 容量、最旧/最新 id 边界由 bridge 维护；外部不直接访问 |
| `UiSnapshot / RuntimeSnapshot` | interfaces/server | interfaces/server | **不在 bridge 职责范围**；stream.gap 触发客户端调用 getSnapshot() |
| JSON 序列化约束 | 发布方传入，bridge 校验 | bridge 强制 | 发布方有责任确保 data 可序列化；bridge 在发布时校验，失败抛出 |

**scope 生命周期归属**：
- `'app'` scope：随 daemon 生命周期，daemon 退出时调用 `end('app')`
- `'run/<runId>'` scope：随 Run 生命周期，run 结束时调用 `end(scope)`；由 run-manager 负责调用

**scope 与事件命名约束**：
- 不新增 `command` scope；command/interaction 事件发布到 `'app'` scope。
- 不新增 `permission` 或 `runtime` scope；这些都是 app scope 的协议事件。
- run 相关高频 delta 可以发布到 `run/<runId>` scope；是否同时投影到 app scope 由 SDK adapter/server 策略决定。
