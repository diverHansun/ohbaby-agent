# bus 模块 data-model.md

本文档描述 `bus` 模块的核心概念与数据模型。bus 模块作为基础设施，数据模型相对简单。

---

## 一、Core Concepts（核心概念）

### 1.1 EventDefinition（事件定义）

事件定义是 Bus 模块的核心抽象，由 `BusEvent.define()` 创建。

**定义**：描述一类事件的标识和数据结构的对象。

**属性**：
- `type`：事件类型字符串，用于匹配订阅者（如 "permission.updated"）
- `schema`：Zod Schema，定义事件 payload 的数据结构

**用途**：
- 作为 `Bus.publish()` 和 `Bus.subscribe()` 的第一个参数
- 提供编译时和运行时的类型安全

**生命周期**：
- 由业务模块在模块加载时创建
- 应用运行期间保持不变
- 通常作为模块常量导出

### 1.2 Subscription（订阅）

订阅是事件类型与回调函数的绑定关系。

**定义**：将一个回调函数注册到特定事件类型的行为。

**内部表示**：
- 键：事件类型字符串（`type`）
- 值：回调函数集合（`Set<Callback>`）

**生命周期**：
- 通过 `Bus.subscribe()` 创建
- 通过返回的取消函数销毁
- 模块卸载时应主动取消订阅

### 1.3 Payload（事件载荷）

事件携带的数据。

**定义**：发布事件时传递给所有订阅者的数据对象。

**约束**：
- 必须符合事件定义中的 Zod Schema
- 应为纯数据对象，不包含函数或类实例
- 发布后不应被修改（不可变性）

---

## 二、Type Definitions（类型定义）

### 2.1 BusEvent.Definition

事件定义的类型签名：

```typescript
namespace BusEvent {
  // 事件定义的类型（参考 opencode 实现）
  export type Definition = ReturnType<typeof define>

  // 事件定义工厂函数
  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties
  ) {
    return { type, properties } as const
  }

  // 从定义中提取 payload 类型
  type PayloadOf<D extends Definition> = z.infer<D['properties']>
}
```

**类型推断示例**：

```typescript
// 定义事件
const MyEvent = BusEvent.define("my.event", z.object({ id: z.string() }))

// MyEvent 的推断类型：
// {
//   readonly type: "my.event"
//   readonly properties: ZodObject<{ id: ZodString }>
// }

// 类型安全的使用
Bus.publish(MyEvent, { id: "123" })  // 正确
Bus.publish(MyEvent, { id: 123 })    // 类型错误
```

### 2.2 Bus 接口

```typescript
namespace Bus {
  // 发布事件
  function publish<T extends BusEvent.Definition>(
    event: T,
    payload: BusEvent.PayloadOf<T>
  ): void

  // 订阅事件
  function subscribe<T extends BusEvent.Definition>(
    event: T,
    callback: (payload: BusEvent.PayloadOf<T>) => void
  ): () => void  // 返回取消订阅函数
}
```

---

## 三、Data Flow（数据流向）

### 3.1 事件发布流程

```
发布者                      Bus 内部                        订阅者
   │                           │                              │
   │  publish(Event, payload)  │                              │
   │─────────────────────────>│                              │
   │                           │                              │
   │                     查找 subscriptions[Event.type]       │
   │                           │                              │
   │                     遍历所有 callback                     │
   │                           │──────────────────────────────>│
   │                           │        callback(payload)      │
   │                           │<──────────────────────────────│
   │                           │                              │
   │  返回 void               │                              │
   │<─────────────────────────│                              │
```

### 3.2 订阅流程

```
订阅者                      Bus 内部
   │                           │
   │  subscribe(Event, cb)     │
   │─────────────────────────>│
   │                           │
   │                     subscriptions[Event.type].add(cb)
   │                           │
   │  返回 unsubscribe 函数    │
   │<─────────────────────────│
   │                           │
   │  调用 unsubscribe()       │
   │─────────────────────────>│
   │                           │
   │                     subscriptions[Event.type].delete(cb)
   │                           │
```

---

## 四、Event Catalog（事件目录）

Bus 模块本身不定义任何业务事件。以下是使用 Bus 的业务模块及其事件（供参考）：

### 4.1 Message 模块事件

| 事件 | 类型字符串 | Payload |
|------|-----------|---------|
| Message.Event.Updated | "message.updated" | { info: MessageInfo } |
| Message.Event.Removed | "message.removed" | { sessionId, messageId } |
| Message.Event.PartUpdated | "message.part-updated" | { part, delta? } |
| Message.Event.PartRemoved | "message.part-removed" | { sessionId, messageId, partId } |

### 4.2 Permission 模块事件

| 事件 | 类型字符串 | Payload |
|------|-----------|---------|
| Permission.Event.Updated | "permission.updated" | PermissionInfo |
| Permission.Event.Replied | "permission.replied" | { sessionId, permissionId, response } |
| Permission.Event.SwitchModeRequested | "permission.switch-mode-requested" | { sessionId, targetMode, trigger } |

### 4.3 Policy 模块事件

| 事件 | 类型字符串 | Payload |
|------|-----------|---------|
| Policy.Event.ModeChanged | "policy.mode-changed" | { previousMode, currentMode } |
| Policy.Event.AgentStateChanged | "policy.agent-state-changed" | { previousState, currentState } |

---

## 五、Constraints（约束）

### 5.1 事件类型唯一性

同一事件类型字符串只能有一个定义。如果多个模块定义相同的类型字符串，行为未定义。

**命名规范**（强制执行）：

- **格式**：`<module>.<action>` 或 `<module>.<entity>.<action>`
- **最多 3 级**：避免过深的层次结构
- **小写 + kebab-case**：使用连字符分隔单词
- **动词时态**：使用过去时（updated、created、deleted）或被动语态（requested）
- **避免缩写**：使用完整单词，不使用缩写

**正确示例**：

| 事件类型 | 说明 |
|---------|------|
| `permission.updated` | 2 级，过去时 |
| `message.part-updated` | 3 级，复合实体 |
| `policy.mode-changed` | 2 级，kebab-case |
| `session.created` | 2 级，过去时 |

**错误示例**：

| 事件类型 | 问题 |
|---------|------|
| `perm.upd` | 使用了缩写 |
| `permission.request.switch.mode` | 超过 3 级 |
| `PermissionUpdated` | 使用了 PascalCase |
| `permission_updated` | 使用了下划线 |
| `permission.update` | 使用了原形动词而非过去时 |

### 5.2 Payload 不可变性

事件 payload 发布后不应被修改。订阅者收到的是同一个对象引用，修改会影响其他订阅者。

**建议**：
- 发布者在发布前完成所有构建
- 订阅者不要修改收到的 payload

### 5.3 回调函数规范

订阅回调应遵循以下规范：
- 执行时间应尽可能短（避免阻塞其他订阅者）
- 长时间操作应异步化（使用 `setTimeout` 或 `queueMicrotask`）
- 抛出的异常会被 Bus 捕获，不会影响其他订阅者

---

## 六、文档自检

- [x] 所有概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 概念在后续接口和数据流中都有使用场景
- [x] 类型定义与架构文档一致
- [x] 事件目录涵盖已设计的业务模块
