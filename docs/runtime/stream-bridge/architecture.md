# stream-bridge 模块 architecture.md

本文档描述 `runtime/stream-bridge` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

stream-bridge 采用 **接口抽象 + 内存实现** 结构，RingBuffer 作为私有数据结构工具独立封装。

```
┌──────────────────────────────────────────────────────────────────┐
│ StreamBridge 接口（公共契约）                                      │
│                                                                  │
│ publish(scope, event, data) / subscribe(scope, lastEventId?)     │
│ / end(scope)                                                     │
└──────────────────────────────────────────────────────────────────┘
                          │ 实现
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ InMemoryStreamBridge（内存实现）                                   │
│                                                                  │
│ 职责：                                                           │
│ - 为每个 runId 和 app scope 维护独立 RingBuffer                   │
│ - 分配单调递增 eventId（per scope）                               │
│ - subscribe()：判断 replay 还是 gap，返回 AsyncIterable           │
│ - 私有方法 getReplayPlan()：封装 gap 检测逻辑                     │
│ - 强制 payload JSON 序列化约束                                    │
│ - 定时发送 HEARTBEAT_SENTINEL；run 结束时发送 END_SENTINEL        │
└──────────────────────────────────────────────────────────────────┘
                          │ 使用
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ RingBuffer<T>（私有工具）                                          │
│                                                                  │
│ 职责：                                                           │
│ - 定长环形缓冲，append 时覆写最旧条目                              │
│ - 维护 oldestId / latestId 边界                                  │
│ - getRange(fromId, toId)：返回指定 id 范围的条目                  │
│ - isContinuous(lastEventId)：判断 id 是否在 buffer 范围内         │
└──────────────────────────────────────────────────────────────────┘
```

### gap 检测的位置

gap 检测逻辑内联在 `InMemoryStreamBridge` 的私有方法 `getReplayPlan()` 中，不独立为文件：

```typescript
// in-memory.ts 私有方法
private getReplayPlan(scope: Scope, lastEventId: number): ReplayPlan {
  const buffer = this.getBuffer(scope)
  if (lastEventId < buffer.oldestId - 1) {
    return { kind: 'gap', oldestRetainedEventId: buffer.oldestId, ... }
  }
  return { kind: 'replay', fromId: lastEventId + 1 }
}
```

gap 检测目前就是一个 if 条件，与 `subscribe()` 的语义强绑定，独立文件会"为拆而拆"。

### 主要组件

| 组件 | 职责 |
|---|---|
| **StreamBridge 接口** | 公共契约，发布到 ohbaby-sdk |
| **InMemoryStreamBridge** | 内存实现：RingBuffer 管理、gap 检测、AsyncIterable 生成 |
| **RingBuffer** | 私有数据结构：定长环形缓冲，维护 id 边界（私有） |

### scope 与协议事件名

stream-bridge 只维护两类 scope：

| scope | 含义 | 常见事件名 |
|------|------|------------|
| `app` | 进程级全局事件流 | `runtime.updated`、`permission.requested`、`command.started`、`interaction.requested` |
| `run/<runId>` | 单个 run 的事件流 | `run.updated`、`message.part.delta`、tool/run 相关 delta |

`command.*` 和 `interaction.*` 是 SDK 协议事件名，不是 bridge scope。它们由 `daemon/command-events.ts` 发布到 `app` scope。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 接口与实现分离（面向接口编程）

`StreamBridge` 是抽象接口，`InMemoryStreamBridge` 是当前实现。未来可以替换为 `SseStreamBridge` 或 `WebSocketStreamBridge`，调用方（run-manager/worker、interfaces/server）不需要修改。

**使用理由**：
- MVP 阶段只做内存版，但接口从第一天起就满足跨进程传输的约束（JSON 序列化、eventId、buffer）
- 接口定义在 ohbaby-sdk，是 runtime 与外部消费者的稳定契约

### 2. RingBuffer 独立封装（有状态不变量）

RingBuffer 独立为 `ring-buffer.ts`，封装环形缓冲的边界条件：容量、最旧 id、最新 id、append 覆写、range 查询。

**独立的理由**：
- RingBuffer 有自己的不变量（`oldestId <= latestId`，append 时 oldestId 随覆写推进），值得独立单测
- 放在 `in-memory.ts` 里会把缓冲管理和订阅逻辑混在一起

**不独立 gap-detector.ts 的理由**：gap 检测目前是一个 if 条件（`lastEventId < buffer.oldestId - 1`），与 `subscribe()` 语义强绑定，独立文件是过度拆分。等未来 gap 规则变复杂（不同 client capability、不同 snapshot policy）时再拆。

### 3. stream.gap 作为协议语义（不静默丢弃）

当 ring buffer 覆写导致断层时，bridge 发出 `stream.gap` 事件而不是静默伪造连续性。

**使用理由**：
- client 收到 `stream.gap` 后知道需要拉取 UiSnapshot 重建状态，而不是基于不完整的事件序列做错误推断
- 断层变为协议语义，client 可以做出正确的恢复决策

### 4. bridge scope 不随业务域膨胀

commands、permission、runtime state 都属于 app scope 的事件生产者。bridge 不因为新增业务域而增加 `command`、`permission` 等 scope。

**使用理由**：
- scope 表达传输路由，不表达业务分类。
- app scope 已能满足全局事件广播；业务分类由事件名表达。
- SDK 协议事件名可以独立演进，不反向改变 bridge 的 ring buffer 拓扑。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/stream-bridge/
├── index.ts              # 公共接口：导出 StreamBridge 接口、StreamEvent 类型、InMemoryStreamBridge
├── in-memory.ts          # InMemoryStreamBridge 实现：RingBuffer 管理、gap 检测、AsyncIterable
├── ring-buffer.ts        # RingBuffer<T> 实现（私有工具）
├── types.ts              # StreamEvent 联合类型（含 stream.gap）、HEARTBEAT_SENTINEL、END_SENTINEL
└── __tests__/
    ├── in-memory.test.ts  # subscribe 行为测试（含 gap 场景）
    └── ring-buffer.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 导出 StreamBridge 接口、StreamEvent 类型、InMemoryStreamBridge；ring-buffer.ts 不对外暴露 |
| `in-memory.ts` | 核心实现 | RingBuffer 管理、eventId 分配、subscribe 逻辑（含 getReplayPlan 私有方法）、序列化约束 |
| `ring-buffer.ts` | 私有工具 | 定长环形缓冲，独立可测 |
| `types.ts` | 类型定义 | StreamEvent 联合类型（普通事件 + stream.gap）；常量定义 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`StreamBridge` 接口方法签名；`StreamEvent` 联合类型（含 stream.gap 的 data 结构）；`HEARTBEAT_SENTINEL` / `END_SENTINEL` 常量
- **内部实现**：RingBuffer 的容量配置；eventId 计数器；getReplayPlan 逻辑；AsyncIterable 的生成方式

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. bridge 不生成 UiSnapshot / RuntimeSnapshot

bridge 只发出 `stream.gap` 信号，不负责生成当前 app 状态快照。快照生成由 `interfaces/server` 或 SDK backend adapter 负责。

**代价**：client 收到 `stream.gap` 后需要额外调用 `getSnapshot()` 接口，reconnect 流程涉及两个请求（subscribe + getSnapshot）。但这是正确的职责划分：bridge 是传输层，不是状态仓库。让 bridge 生成快照会使它依赖所有业务模块的状态，违背单一职责。

### 2. eventId 是 per-scope 单调递增，不是全局单调

app scope 和每个 runId scope 各自维护独立的 eventId 计数器。

**代价**：client 订阅多个 scope 时，不同 scope 的 eventId 不可比较。但这是合理的：client 通常只订阅一个 scope（当前 run 或 app），跨 scope 的 eventId 比较没有语义意义。

### 3. 放弃的方案：使用 SSE 协议的 Last-Event-ID 头部作为唯一重连机制

可以完全依赖 HTTP SSE 协议的 `Last-Event-ID` 头部，不在 bridge 层实现 buffer 和 gap 检测，让 HTTP 层处理重连。

**放弃理由**：MVP 阶段的内存版 bridge 不走 HTTP，需要在 bridge 层实现 buffer 和重连语义。即使未来切换到 SSE，bridge 层的 gap 检测也是必要的（SSE 协议本身不提供 gap 语义，只提供 Last-Event-ID 传递）。在 bridge 层统一实现，使内存版和 SSE 版行为一致。
