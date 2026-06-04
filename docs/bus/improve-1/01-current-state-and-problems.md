# Bus 模块优化 — 1. 代码/架构现状与问题分析

> 基于 SWE 审阅模式（learn-swe-before-implement），对 bus 模块及其在系统中的使用现状进行全面分析。

---

## 一、当前架构总览

### 1.1 Bus 模块本身

**位置**：`packages/ohbaby-agent/src/bus/`

| 文件 | 职责 | 行数 |
|------|------|------|
| `index.ts` | 模块入口，导出 `Bus` 全局单例 + 类型 | 15 |
| `bus.ts` | `createBus()` 工厂函数（核心实现） | 57 |
| `bus-event.ts` | `BusEvent.define(type, schema)` 事件定义工厂 | 29 |
| `types.ts` | `BusInstance`, `BusCallback`, `BusOptions` 等类型 | 27 |
| `bus.unit.test.ts` | 5 个单元测试 | 118 |

**核心接口**：

```typescript
interface BusInstance {
  publish<Event>(event: Event, payload: BusEventPayload<Event>): void;
  subscribe<Event>(event: Event, callback: BusCallback<Event>): BusUnsubscribe;
}
```

**设计文档**：`docs/bus/` 下有 3 份设计文档（goals-duty.md, architecture.md, dfd-interface.md），质量较高，明确定义了 5 个设计目标和 7 个非职责。

### 1.2 事件定义分布

8 个域模块各自定义事件，均使用 `BusEvent.define(type, zodSchema)` 模式：

| 域模块 | 事件文件 | 事件数量 | 事件类型前缀 |
|--------|----------|----------|-------------|
| Message | `core/message/events.ts` | 4 | `message.*` |
| Context | `core/context/events.ts` | 4 | `context.*` |
| Memory | `core/memory/events.ts` | 4 | `memory.*` |
| ToolScheduler | `core/tool-scheduler/events.ts` | 3 | `tool-scheduler.*` |
| Permission | `permission/events.ts` | 5 | `permission.*` |
| Session | `services/session/events.ts` | 3 | `session.*` |
| Commands | `commands/events.ts` | 4 | `commands.*.internal` |
| InteractionBroker | `runtime/interaction-broker/events.ts` | 2 | `interaction.*.internal` |

**合计：29 个事件定义**。

### 1.3 当前事件流路径

```
┌──────────────────────────────────────────────────────────────────┐
│  域模块层（发布者）                                                │
│                                                                    │
│  MessageManager ──publish──→ Bus ──→ ?                            │
│  ContextManager ──publish──→ Bus ──→ ?                            │
│  SessionManager ──publish──→ Bus ──→ ?                            │
│  PermissionManager ──publish──→ Bus ──→ ?                         │
│  CommandsService ──publish──→ Bus ──→ ?                           │
│  ToolScheduler ──publish──→ Bus ──→ ?                             │
│  MemoryManager ──publish──→ Bus ──→ ?                             │
│  InteractionBroker ──publish──→ Bus ──→ ?                         │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    Bus (全局单例 subscriptions Map)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  适配层（订阅者）—— 手动桥接                                       │
│                                                                    │
│  daemon/app-events.ts:                                            │
│    bus.subscribe(eventDef, payload → streamBridge.publish(...))   │
│                                                                    │
│  daemon/command-events.ts:                                        │
│    bus.subscribe(CommandsEvent.*, payload → streamBridge.publish) │
│    bus.subscribe(InteractionEvent.*, payload → streamBridge.publish)│
│                                                                    │
│  adapters/ui-inprocess.ts:                                        │
│    bus.subscribe(CommandsEvent.*, payload → publish(UiEvent))     │
│    bus.subscribe(PermissionEvent.*, payload → 状态管理 + publish) │
│    bus.subscribe(InteractionEvent.*, payload → publish(UiEvent))  │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  UI 层                                                            │
│                                                                    │
│  ohbaby-sdk: UiEvent discriminated union (17 种事件类型)          │
│  ohbaby-cli: TUI Store (applyTuiEvent 状态机)                     │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 1.4 两套事件类型体系

| 体系 | 位置 | 定义方式 | 用途 |
|------|------|----------|------|
| BusEvent | `packages/ohbaby-agent/src/*/events.ts` | `BusEvent.define(type, zodSchema)` | 域内事件，Zod 验证 |
| UiEvent | `packages/ohbaby-sdk/src/events.ts` | TypeScript discriminated union | 前端消费，17 种类型 |

两者语义高度重叠（如 `message.updated` 在两处都有定义），但 payload 形状略有不同。适配层负责转换。

---

## 二、问题分析

### 问题 P1：Bus 实际用途与原设计目标不一致，需要重新确认定位

**严重性**：[设计级]
**SWE 依据**：02 章 — 消息耦合是最松散的耦合形式，但当前未被用于域间解耦。

**现状**：所有 29 个事件的生产订阅者都在适配层（daemon 适配器 + ui-inprocess.ts），没有任何域模块订阅另一个域模块的事件。Bus 的实际用途是"领域事件可观察点 + 域→UI 投影素材"，而不是跨域通信骨干。

**影响**：
- 文档 `goals-duty.md` 描述的 "Policy 订阅 Permission 事件" 未实现（注：Policy 模块目前尚未创建，仅存在于设计文档中）
- Bus 的实际定位需要重新确认：它可以继续作为内部领域事件总线，但不应仅凭“无跨域订阅”就强行升级为跨域通信骨干

**但需注意**：
- 不是所有跨域交互都应该走事件。只有"发布者不关心谁在听"的场景才适合
- 部分跨域清理已通过直接调用实现（如 `SessionManager.remove()` 已调用 `messageCleaner.removeMessages()`），不需要事件解耦

---

### 问题 P2：双路径桥接 — daemon 适配器与 ui-inprocess 职责重叠

**严重性**：[设计级]
**SWE 依据**：03 章 DRY — 相同逻辑在两个地方实现。

**现状**：存在两条独立的 bus→UI 桥接路径：

| 路径 | 文件 | 订阅的事件 | 状态 |
|------|------|-----------|------|
| Daemon 路径 | `daemon/app-events.ts` | 通用转发（eventDefinitions 参数） | 仅测试中使用 |
| Daemon 路径 | `daemon/command-events.ts` | Commands + Interaction 事件 | 仅测试中使用 |
| 生产路径 | `adapters/ui-inprocess.ts` | Commands + Permission + Interaction | 当前唯一生产路径 |

**重叠的具体代码**：

```typescript
// daemon/command-events.ts:81-85 — 通用转发
...eventDefinitions.map((eventDefinition) =>
  bus.subscribe(eventDefinition, (payload) => {
    streamBridge.publish("app", eventDefinition.type, payload);
  }),
),

// daemon/app-events.ts:8-12 — 完全相同的通用转发
const unsubscribers = eventDefinitions.map((eventDefinition) =>
  bus.subscribe(eventDefinition, (payload) => {
    streamBridge.publish("app", eventDefinition.type, payload);
  }),
);
```

**影响**：
- 新增事件需要在多处注册转发逻辑
- 两条路径的转换逻辑不完全一致（command-events 用 `withDefined` 过滤 undefined 字段，ui-inprocess 不做过滤）
- `bootstrapRuntime()` 仅在测试中调用，daemon 系统未接入生产

---

### 问题 P3：全局单例 Bus 导致隐式公共耦合

**严重性**：[架构级]
**SWE 依据**：02 章 — 公共耦合是第二坏的耦合类型。

**现状**：`bus/index.ts:15` 导出全局单例：

```typescript
export const Bus: BusInstance = createBus();
```

直接引用此单例的生产代码：

| 文件 | 引用方式 |
|------|----------|
| `permission/manager.ts:104` | `const bus = options.bus ?? Bus;` |
| `permission/state.ts:32` | `const bus = options.bus ?? Bus;` |
| `permission/index.ts` | `import { Bus } from "../bus/index.js"` |
| `runtime/daemon/bootstrap.ts:117` | `const bus = options.bus ?? Bus;` |

**影响**：
- 所有发布者和订阅者共享同一个 `subscriptions` Map
- 多测试并行运行时可能互相污染
- 未来多会话/多实例场景下，事件会串话（session A 的 Permission 事件被 session B 的 Policy 误消费）
- 文档 `goals-duty.md` 约束 5 已承认此问题

**缓解因素**：大部分模块已接受 `bus?: BusInstance` 参数，可通过 DI 注入独立实例。但生产代码中仍有多处 fallback 到全局 `Bus`。

---

### 问题 P4：通用事件转发器丧失编译时可追溯性

**严重性**：[设计级]
**SWE 依据**：05 章 — 事件驱动架构的代价是"控制流变得隐式且难追踪"。

**现状**：`app-events.ts` 接受任意 `eventDefinitions[]` 参数并通用转发：

```typescript
eventDefinitions.map((eventDefinition) =>
  bus.subscribe(eventDefinition, (payload) => {
    streamBridge.publish("app", eventDefinition.type, payload);
  }),
),
```

**影响**：
- "哪些事件会被转发到 UI" 无法从代码静态分析，必须追踪 `appEventDefinitions` 的运行时注入
- `bootstrapRuntime()` 的 `appEventDefinitions` 参数在测试中传入，但生产代码中未调用
- 新增事件的开发者不知道是否需要在某处"注册"转发

---

### 问题 P5：事件 payload 与 UiEvent 形状不一致，需要转换层

**严重性**：[代码级]
**SWE 依据**：06 章 — 代码异味：数据泥团（Data Clumps）。

**现状**：Bus 事件和 UiEvent 语义相同但 payload 结构不同：

```typescript
// Bus 事件 (message/events.ts)
MessageEvent.Updated = BusEvent.define("message.updated", z.object({
  info: MessageSchema,  // 完整 Message 对象
}))

// UiEvent (ohbaby-sdk/events.ts)
interface UiMessageUpdatedEvent {
  type: "message.updated";
  sessionId: string;     // 额外的 sessionId 字段
  message: UiMessage;    // 字段名不同 (info → message)
  timestamp?: number;    // 额外的 timestamp
}
```

**影响**：
- 适配层（ui-inprocess.ts）需要逐事件做字段映射
- 两套类型定义需要保持同步（MessageSchema 37 行，整个 schema 区域含 PartSchema/ToolStateSchema 约 134 行 vs UiMessage 类型）
- 新增域事件时必须同时定义 Bus 事件和 UiEvent 两份

---

### 问题 P6：大型 Zod Schema 在 publish 路径上

**严重性**：[代码级]
**SWE 依据**：06 章 — 性能相关的代码异味。

**现状**：`message/events.ts` 的 schema 区域（MessageSchema 37 行 + PartSchema/ToolStateSchema 等共约 134 行）包含 discriminatedUnion、嵌套 object 等复杂 Zod 定义。每次 `publish(MessageEvent.Updated, ...)` 都会执行 `event.schema.parse(payload)`。

**影响**：
- publish 路径上有不必要的运行时开销（Zod 解析完整 Message 对象）
- 如果 Message 类型变更，需要同步修改 events.ts 中的 Zod schema 和 types.ts 中的 TypeScript 类型
- 对于高频事件（如 `MessageEvent.PartUpdated`，每个 token 都会触发），性能影响可能显著

---

### 问题 P7：daemon 系统未接入生产

**严重性**：[设计级]
**SWE 依据**：00 章 — 技术债：有意识的债是合理的，但需要记录。

**现状**：`bootstrapRuntime()` 函数只在 `bootstrap.integration.test.ts` 中被调用，生产代码中无任何调用点。整个 daemon 事件适配系统（app-events.ts、command-events.ts、bootstrap.ts）是"已完成但未接入"的状态。

**影响**：
- 存在大量"已写好但未使用"的代码
- 如果未来要接入 daemon 系统，需要解决与 ui-inprocess.ts 的冲突
- 当前生产路径（ui-inprocess.ts）缺少 daemon 系统的生命周期管理（start/stop/dispose）

---

## 三、风险地图汇总

| 编号 | 问题 | 严重性 | 可优化性 | 位置 | 建议优先级 |
|------|------|--------|----------|------|-----------|
| P1 | Bus 退化为 UI 通知管道 | [设计级] | [战略投资] | 全项目 | 第三优先 |
| P2 | 双路径桥接 | [设计级] | [低垂果实] | daemon/ + adapters/ | 第一优先 |
| P3 | 全局单例公共耦合 | [架构级] | [战略投资] | bus/index.ts | 第二优先 |
| P4 | 通用转发器不可追溯 | [设计级] | [低垂果实] | daemon/app-events.ts | 第一优先 |
| P5 | 事件 payload 与 UiEvent 不一致 | [代码级] | [战略投资] | 各域 events.ts | 第一优先（与 P2 联动） |
| P6 | 大型 Zod Schema 性能 | [代码级] | [锦上添花] | message/events.ts | 暂缓 |
| P7 | daemon 系统未接入生产 | [设计级] | [战略投资] | runtime/daemon/ | 与 P2 联动 |

**建议实施顺序**：P2+P4+P5+P7 → P3 → P1

---

## 四、做得好的部分（不应改动）

1. **Bus 模块核心实现**：57 行代码，职责单一，错误隔离完善，测试覆盖 5 个核心场景。不需要重写。
2. **分布式事件定义**：事件定义与发布者放在一起，高内聚。不应改为集中式定义。
3. **BusEvent.define() 工厂**：类型安全，Zod 验证，编译时 + 运行时双重保障。保留此模式。
4. **设计文档**：goals-duty.md 的 Non-Duties 章节是教科书级的 YAGNI 实践。
5. **同步分发**：对 CLI 工具来说，同步分发比异步队列更简单、更可预测。保留此选择。

---

## 五、协商修订结论（2026-06-04）

后续设计讨论确认：`Bus` 不升级为统一 UI 协议事件管线，而继续作为**内部领域事件总线**。因此本文件的问题优先级需要按以下方式理解：

1. **P2/P4 是 Phase 1 主目标**：先通过显式 projector table 消除 Commands/Interaction 在 daemon 与 `ui-inprocess` 中的重复映射，并保持转发路径可追踪。
2. **P5 不在 Phase 1 全量解决**：BusEvent payload 与 `UiEvent` 不一致不一定是坏事。领域事件可以保持领域语义，UI 协议转换由 projector 负责。`Message/Context/Memory/ToolScheduler/Session` 的 payload 审计后移到 Phase 3。
3. **P3 是 Phase 2 主目标**：先做 per-backend bus 与显式注入，移除生产路径对全局 `Bus` 的 fallback；不提前做 per-session bus。
4. **P1 需要测试证据**：当前没有足够跨域订阅场景支撑把 Bus 扩展成跨域通信骨干。Phase 3 通过事件 scope 审计和串话测试判断是否需要 per-session bus 或局部 session-scoped event source。
5. **P7 不应通过自动桥接解决**：daemon 与 in-process 可以共享 pure projector，但 Permission 这类 stateful projection 不应被强行合并成通用桥接逻辑。

修订后的推荐顺序为：

```
Phase 1: 显式 app/UI projectors（零 Bus API 改动）
Phase 2: 全局 Bus fallback 清理，确立 per-backend bus
Phase 3: 事件契约与 scope 审计，测试后判断是否需要 per-session bus
Phase 4: 仅在 Phase 3 证明必要时实施 per-session bus 或局部 session event source
```
