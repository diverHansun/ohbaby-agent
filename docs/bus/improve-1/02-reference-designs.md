# Bus 模块优化 — 2. 基于优秀项目的借鉴设计方案

> 深入分析 opencode 和 kimi-code 的事件系统设计，提炼可借鉴的设计原则和具体模式。

---

## 一、opencode 的事件架构

### 1.1 两层架构

opencode 采用**两层事件总线**：

```
┌─────────────────────────────────────────┐
│         GlobalBus                        │
│  (Node.js EventEmitter 全局单例)         │
│  跨实例、跨进程通信                       │
└──────────┬──────────────────────────────┘
           │ SSE / RPC
     ┌─────┼─────────────────────┐
     │     │                     │
┌────▼─────▼──────┐       ┌─────▼──────┐
│ Instance-Scoped  │       │  TUI       │
│ Bus (per-directory)│     │  Worker    │
│ Effect PubSub    │       └────────────┘
│                  │
│ ┌──────────┐     │
│ │ wildcard │     │  ← 所有事件的广播通道
│ │ typed    │     │  ← 按事件类型的专用通道
│ └──────────┘     │
└──────────────────┘
```

### 1.2 核心设计决策

#### 决策 1：自动桥接（Auto-Bridging，ohbaby 不照搬）

opencode 的一个关键设计是：每次 `Bus.publish()` 内部自动调用 `GlobalBus.emit()`。这适合 opencode 的 server/SSE/workspace 架构，但 ohbaby 不应直接照搬为 `Bus.publish()` 自动 UI 出口。

```typescript
// opencode/packages/opencode/src/bus/index.ts
function publish<D extends BusEvent.Definition>(def: D, properties: BusProperties<D>) {
  return Effect.gen(function* () {
    const s = yield* InstanceState.get(state)
    const payload: Payload = { type: def.type, properties }

    // 1. 发布到类型专用通道
    const ps = s.typed.get(def.type)
    if (ps) yield* PubSub.publish(ps, payload)

    // 2. 发布到通配通道（所有订阅者都能收到）
    yield* PubSub.publish(s.wildcard, payload)

    // 3. 自动桥接到 GlobalBus（跨实例/前端）
    const dir = yield* InstanceState.directory
    GlobalBus.emit("event", { directory: dir, project, workspace, payload })
  })
}
```

**效果**：
- 在 opencode 中，无需手动适配器代码。
- 在 opencode 中，每个事件自动到达 SSE 端点。
- 对 ohbaby 的借鉴点是“事件出口可观察、可集中治理”，不是把内部 Bus event 全量暴露到 UI/StreamBridge。

#### 决策 2：实例隔离（Instance Scoping）

通过 Effect 的 `ScopedCache` 实现 per-directory 状态隔离：

```typescript
const state = yield* InstanceState.make<State>(
  Effect.fn("Bus.state")(function* (ctx) {
    const wildcard = yield* PubSub.unbounded<Payload>()
    const typed = new Map<string, PubSub.PubSub<Payload>>()
    // ... 设置清理 finalizer ...
    return { wildcard, typed }
  }),
)
```

**效果**：
- 每个项目目录拥有独立的 Bus 实例
- 事件不会跨实例泄漏
- 实例销毁时自动清理 PubSub 通道

#### 决策 3：双事件系统（BusEvent + SyncEvent）

| 系统 | 持久化 | 版本控制 | 用途 |
|------|--------|----------|------|
| BusEvent | 否 | 否 | 实时状态变化、UI 信号 |
| SyncEvent | 是（SQLite） | 是 | 会话/消息领域事件，支持重放 |

**效果**：
- 关注点分离：实时通知 vs 持久化历史
- SyncEvent 支持事件溯源（event sourcing）
- 前端通过 REST API 获取 SyncEvent 数据，通过 SSE 接收 BusEvent 实时通知

#### 决策 4：全局事件注册表（Registry）

```typescript
// opencode/packages/opencode/src/bus/bus-event.ts
const registry = new Map<string, Definition>()

export function define<Type extends string, Properties extends Schema.Top>(
  type: Type,
  properties: Properties,
): Definition<Type, Properties> {
  const result = { type, properties }
  registry.set(type, result)  // 自动注册
  return result
}

export function payloads() {
  // 生成 OpenAPI/zod schemas（用于 API 文档）
  return registry.entries().map(([type, def]) => z.object({
    type: z.literal(type),
    properties: zodObject(def.properties),
  })).toArray()
}
```

**效果**：
- 所有事件类型集中可查
- 自动生成 API 文档（OpenAPI schema）
- 运行时可按 type 字符串查找事件定义

#### 决策 5：通配符订阅（Wildcard Subscribe）

```typescript
// 订阅所有事件（用于 SSE 流、调试日志）
Bus.subscribeAll((event) => {
  // event 包含 { type, properties }
  sseStream.write(event)
})
```

**效果**：
- SSE 端点只需一个订阅即可转发所有事件
- 调试时可全局监听所有事件流

### 1.3 opencode 的跨域事件通信

opencode 中确实存在域间事件订阅：

| 发布者 | 事件 | 订阅者 | 用途 |
|--------|------|--------|------|
| Permission | `permission.replied` | Session/LLM | LLM 收到权限响应后继续执行 |
| LSP Client | `lsp.diagnostics` | LSP Client 自身 | 内部状态更新 |
| FileWatcher | `file.watcher.updated` | 多处 | 文件变化触发重新分析 |

**关键观察**：跨域事件只用于**真正的解耦场景**（如 LLM 等待权限响应），不用于简单的通知。

---

## 二、kimi-code 的事件架构

### 2.1 RPC 反向通道

kimi-code **没有传统的事件总线**，而是使用**双向 RPC 通道**：

```
┌─────────────────────────────────────────┐
│  CONSUMER LAYER (TUI / CLI / Tests)     │
│  session.onEvent(fn) → 按 sessionId 过滤 │
├─────────────────────────────────────────┤
│  SDK LAYER (node-sdk)                   │
│  SDKRpcClient                           │
│  ├─ eventListeners: Set<(event) => void>│
│  ├─ receiveEvent → fan-out              │
│  └─ ClientAPI.emitEvent()               │
├───────────── RPC Channel ───────────────┤
│  createRPC<CoreAPI, SDKAPI>()           │
│  ├─ CoreAPI (正向): prompt/cancel/...   │
│  └─ SDKAPI (反向): emitEvent/...        │
├─────────────────────────────────────────┤
│  CORE LAYER (agent-core)                │
│  Agent.emitEvent(event)                 │
│  → this.rpc.emitEvent(event)            │
└─────────────────────────────────────────┘
```

### 2.2 核心设计决策

#### 决策 1：Per-Session 隔离

每个 Session 拥有独立的 RPC 通道：

```typescript
// kimi-code/packages/agent-core/src/session/index.ts
class Session {
  readonly rpc: SDKSessionRPC  // 独立的反向通道
  readonly agents: Map<string, Agent>
}
```

**效果**：
- 事件天然隔离，不会跨 session 泄漏
- 无需全局单例，无需手动清理
- 每个 session 的生命周期与 RPC 通道绑定

#### 决策 2：单一 Discriminated Union

所有 26 种事件定义在一个 union type 中：

```typescript
// kimi-code/packages/agent-core/src/rpc/events.ts
export type AgentEvent =
  | ErrorEvent                          // 'error'
  | AgentStatusUpdatedEvent             // 'agent.status.updated'
  | TurnStartedEvent                    // 'turn.started'
  | TurnEndedEvent                      // 'turn.ended'
  | AssistantDeltaEvent                 // 'assistant.delta'
  | ToolCallStartedEvent                // 'tool.call.started'
  | ToolResultEvent                     // 'tool.result'
  // ... 共 26 种
```

**效果**：
- TypeScript 的 exhaustiveness checking 可捕获未处理的事件类型
- 所有事件类型一目了然
- 新增事件时必须更新 union，编译器强制所有消费者处理

#### 决策 3：AgentId 注入（Proxy 模式）

```typescript
// kimi-code/packages/agent-core/src/rpc/types.ts
function proxyWithExtraPayload(rpc, { agentId }) {
  return {
    emitEvent(event) {
      return rpc.emitEvent({ ...event, agentId })  // 自动注入 agentId
    }
  }
}
```

**效果**：
- 域模块（Turn、Tool、Compaction）无需知道 agentId
- 事件自动携带 agentId，消费者可按 agent 过滤
- 干净的关注点分离

#### 决策 4：双通道分发器（LoopEventDispatcher）

```typescript
// kimi-code/packages/agent-core/src/loop/events.ts
function createLoopEventDispatcher(input) {
  return function dispatchEvent(event: LoopEvent) {
    if (isRecordedEvent(event)) {
      return recordEvent(input, event)   // 持久化 + 发送
    }
    safeEmitLive(input.emitLiveEvent, event)  // 仅发送（流式）
  }
}
```

**效果**：
- 清晰区分"需要持久化的事件"和"仅流式传输的事件"
- 持久化事件写入 wire.jsonl（用于回放/调试）
- 流式事件（如 text.delta）不持久化，减少存储开销

#### 决策 5：错误韧性（Error Resilience）

```typescript
// kimi-code/packages/agent-core/src/loop/events.ts
function safeEmitLive(emit, event) {
  try {
    emit(event)
  } catch {
    // 静默吞掉订阅者错误，不影响主流程
  }
}
```

**效果**：
- 订阅者错误不会崩溃发布者
- 与 ohbaby 的 bus.ts 错误隔离设计一致

### 2.3 kimi-code 的跨域事件通信

kimi-code 的跨域通信通过**内部生命周期回调**实现，而非事件总线：

| 发布者 | 机制 | 订阅者 | 用途 |
|--------|------|--------|------|
| BackgroundProcessManager | `onLifecycle(callback)` | BackgroundManager | 桥接到 agent.emitEvent |
| McpConnectionManager | `onStatusChange(listener)` | Session, ToolManager | MCP 状态变化通知 |

**关键观察**：kimi-code 用小范围的回调模式（而非全局事件总线）处理跨域通信。这更简单，但扩展性较差。

---

## 三、对比分析：opencode vs kimi-code vs ohbaby-agent

| 维度 | ohbaby-agent（当前） | opencode | kimi-code |
|------|---------------------|----------|-----------|
| **实例隔离** | 全局单例 `Bus` | Per-directory `InstanceState` | Per-session RPC 通道 |
| **事件→UI 传输** | 手动适配器 | `publish()` 自动桥接 | RPC 反向通道 |
| **事件定义** | 分散 + Zod | 分散 + Effect Schema + Registry | 集中 discriminated union |
| **跨域通信** | 无 | 少量（Permission->LLM） | 内部回调模式 |
| **持久化** | 无 | SyncEvent 事件溯源 | LoopEventDispatcher |
| **订阅 API** | `subscribe(event, cb)` → 取消函数 | Stream + callback 双 API | `onEvent(fn)` → 取消函数 |
| **错误隔离** | 双层 try-catch | Effect 错误处理 | safeEmitLive |
| **复杂度** | 低（57 行核心） | 高（Effect 生态） | 中（RPC 基础设施） |

---

## 四、可借鉴的设计原则

### 原则 1：显式投影层（修订自 opencode 自动桥接）

**核心思想**：借鉴 opencode 的“事件有统一出口”思想，但不把 `Bus.publish()` 改成自动 UI 出口。ohbaby 使用显式 projector table 把允许进入 UI/app stream 的事件投影出去。

**ohbaby 适用性**：高。当前 ohbaby 的重复点主要在 Commands/Interaction 的字段映射，而不是 Bus 核心能力不足。

**实现方式**：新增 projection 层，而不是修改 `BusOptions`：

```typescript
interface ProjectedAppEvent {
  readonly type: string;
  readonly uiEvent: UiEvent;
}

interface AppStreamEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

interface AppEventProjector<Event extends BusEventDefinition> {
  readonly event: Event;
  project(payload: BusEventPayload<Event>): ProjectedAppEvent | undefined;
}
```

`ui-inprocess` 直接发布 `uiEvent`；daemon adapter 先把 `uiEvent.type` 剥离为 stream `type`，再把剩余字段作为 `data` 发布。Permission 这类有状态副作用的事件单独做 stateful projection。

### 原则 2：实例隔离（来自 opencode + kimi-code）

**核心思想**：每个会话/实例拥有独立的 Bus，事件不跨实例泄漏。

**ohbaby 适用性**：中。当前阶段先做 per-backend bus 和显式注入；是否需要 per-session bus，要等 Phase 3 的 scope 和串话测试给出证据。

**实现方式**：
- 短期：移除生产路径对全局 `Bus` 的 fallback，组合层显式 `createBus()` 并注入。
- 中期：为所有 BusEvent 标注 app/project/session/run scope，并补契约测试。
- 长期：如果测试证明 per-backend bus 不足，再评估 per-session bus 或局部 session-scoped event source。

### 原则 3：事件目录 / 注册表（来自 opencode，Phase 3 候选）

**核心思想**：所有事件定义自动注册到全局 registry，支持运行时查询。

**ohbaby 适用性**：中，但不进入 Phase 1。运行时全局 registry 会引入新的全局可变状态，和“先清理全局 Bus fallback”的方向相冲突。

**推荐实现方式**：Phase 3 先做文档化 `event-catalog.md` 与契约测试；若后续确实需要运行时查询或文档生成，再评估 registry。

```typescript
interface EventCatalogEntry {
  readonly type: string;
  readonly owner: string;
  readonly scope: "app" | "project" | "session" | "run";
  readonly uiVisible: "yes" | "no" | "via-projector";
}
```

### 原则 4：Discriminated Union 类型（来自 kimi-code）

**核心思想**：所有事件类型定义在一个 union type 中，支持 exhaustiveness checking。

**ohbaby 适用性**：中。当前分散定义有利于内聚，但缺乏全局视图。该 union 应留在内部 catalog/test 层，不应放进 `ohbaby-sdk` 暴露内部 BusEvent。

**实现方式**：在 `ohbaby-agent` 内部定义测试辅助类型或 catalog 类型：

```typescript
// packages/ohbaby-agent/src/bus/event-catalog.ts
export type InternalBusEvent =
  | MessageEvent.Updated
  | MessageEvent.PartUpdated
  | ContextEvent.Compressed
  | SessionEvent.Created
  // ... 所有事件
```

### 原则 5：双通道分发（来自 kimi-code）

**核心思想**：区分"需要持久化的事件"和"仅流式传输的事件"。

**ohbaby 适用性**：低。当前 MVP 阶段无事件持久化需求。

**未来考虑**：如果 ohbaby 需要会话回放/调试功能，可引入此模式。

---

## 五、不建议借鉴的设计

### 1. Effect 生态（opencode）

opencode 使用 Effect 库实现响应式编程。ohbaby 不使用 Effect，引入会增加大量学习成本和依赖。

**替代方案**：用简单的回调 + 工厂函数实现相同效果。

### 2. SyncEvent 事件溯源（opencode）

opencode 的 SyncEvent 系统支持事件持久化和重放。ohbaby 当前无此需求，YAGNI。

**替代方案**：如果未来需要会话历史回放，可独立实现，不影响 Bus 模块。

### 3. 双向 RPC 通道（kimi-code）

kimi-code 的 RPC 反向通道设计精巧，但 ohbaby 的架构不需要跨进程通信。当前 in-process 架构用回调更简单。

**替代方案**：保持 in-process 回调模式，未来如需 daemon 模式再引入 RPC。

### 4. 集中式事件定义（kimi-code）

kimi-code 将所有 26 种事件定义在一个文件中。ohbaby 的分散定义更符合"事件与发布者放在一起"的内聚原则。

**替代方案**：保持分散定义，通过 registry 提供全局视图。

---

## 六、综合建议

基于以上分析，推荐 ohbaby-agent 借鉴以下设计：

1. **显式投影层**（综合 opencode/kimi-code）— 消除手动重复映射，但不把 `Bus.publish()` 变成 UI 自动出口
2. **实例所有权清晰化**（opencode + kimi-code）— 先做 per-backend bus 与显式注入，再用测试判断是否需要 per-session bus
3. **事件注册表 / 事件目录**（opencode）— 提供全局事件目录和 scope 审计基础

不借鉴：
- Effect 生态（复杂度过高）
- SyncEvent 事件溯源（YAGNI）
- 双向 RPC（当前 in-process 足够）
- 集中式事件定义（破坏内聚）

---

## 七、协商修订结论（2026-06-04）

本轮讨论后，对参考项目的借鉴方式做如下修订：

### 7.1 opencode：借鉴边界，不照搬自动桥接

opencode 的 `Bus.publish()` 自动进入 `GlobalBus`，适合它的 server/SSE/workspace 架构。ohbaby 当前已有 `StreamBridge` 的 `run/{runId}` 流，且 `ui-inprocess` 中 Permission 投影有状态副作用，因此不采用“所有 Bus event 自动桥接到 UI”。

ohbaby 更适合借鉴：

- typed event definitions
- wildcard/registry 的可观察性思想（Phase 3 评估）
- BusEvent 与持久/协议事件分层的思想

### 7.2 kimi-code：借鉴 session-scoped event source 的判断方式

kimi-code 没有全局通用 Bus，而是通过 SDK-facing `AgentEvent` union 和 `Session.onEvent()` 做 session 过滤。ohbaby 当前不直接照搬 RPC，但借鉴两个原则：

- 内部事件不必迎合 UI 协议 payload。
- 是否需要物理隔离（per-session bus）应由 scope 测试和串话测试决定。

### 7.3 最终取舍

当前推荐不是“自动桥接”，而是：

```
Bus = 内部领域事件总线
Projector = 显式 UI/app 协议投影
StreamBridge = run/app transport
```

这能清理重复代码，同时避免把 Bus 过早设计成系统级事件中枢。
