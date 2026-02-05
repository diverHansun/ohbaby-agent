# bus 模块 architecture.md

本文档描述 `bus` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

bus 模块采用**极简发布/订阅架构**，核心逻辑控制在 100 行以内：

```
┌─────────────────────────────────────────────────────────────────┐
│                           Bus 模块                               │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ BusEvent.define()                                         │  │
│  │                                                           │  │
│  │ 职责：事件定义工厂，返回类型安全的事件定义                   │  │
│  │ 输入：type (字符串) + schema (Zod Schema)                  │  │
│  │ 输出：{ type, schema } 对象                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Bus (核心)                                                 │  │
│  │                                                           │  │
│  │ 职责：                                                    │  │
│  │ - 维护订阅者列表 Map<string, Set<Callback>>               │  │
│  │ - publish()：分发事件到所有匹配订阅者                      │  │
│  │ - subscribe()：注册订阅者，返回取消函数                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **BusEvent.define** | 事件定义工厂函数，创建类型安全的事件定义 |
| **Bus.publish** | 发布事件，同步调用所有匹配的订阅者 |
| **Bus.subscribe** | 注册订阅者，返回取消订阅函数 |

### 数据结构

```typescript
// 内部状态（模块私有）
const subscriptions: Map<string, Set<Callback>> = new Map()

// 事件定义类型
interface EventDefinition<T extends string, S extends z.ZodType> {
  type: T
  schema: S
}

// 回调类型
type Callback<S extends z.ZodType> = (payload: z.infer<S>) => void
```

---

## 二、Design Pattern and Rationale（设计模式与理由）

### 1. 发布/订阅模式（Pub/Sub）

**使用理由**：
- 发布者和订阅者完全解耦，互不感知
- 支持一对多通信（一个事件多个订阅者）
- 简单、成熟、易于理解的模式

**实现选择**：内存 Map 存储订阅者

**不采用 EventEmitter 的理由**：
- 避免 Node.js 原生依赖，保持跨平台兼容性
- 控制实现细节，如错误隔离策略
- 更简单的类型推断

### 2. 工厂模式（Factory）

**使用理由**：
- `BusEvent.define()` 作为工厂函数创建事件定义
- 封装类型推断逻辑，调用方无需手动定义类型
- 保持事件定义的一致性

**实现方式**：
```typescript
// 业务模块使用
const MyEvent = BusEvent.define("my.event", z.object({
  id: z.string(),
  value: z.number()
}))

// 类型自动推断
Bus.publish(MyEvent, { id: "123", value: 42 }) // ✅ 类型安全
Bus.publish(MyEvent, { id: 123 })              // ❌ 编译错误
```

### 3. 分布式事件定义

**使用理由**：
- 事件定义与业务逻辑放在一起，高内聚
- 新增事件无需修改 Bus 模块，遵循开放封闭原则
- 避免集中式事件类型文件变得臃肿

**实现方式**：
```typescript
// permission/events.ts 或 permission/index.ts
export namespace Permission {
  export const Event = {
    Updated: BusEvent.define("permission.updated", PermissionInfoSchema),
    Replied: BusEvent.define("permission.replied", RepliedPayloadSchema),
  }
}

// policy/events.ts 或 policy/index.ts
export namespace Policy {
  export const Event = {
    ModeChanged: BusEvent.define("policy.mode-changed", ModeChangedSchema),
  }
}
```

### 4. 未使用的模式

**未使用中间件/管道模式**：
- 当前需求不需要事件拦截或转换
- 保持简单，KISS 原则
- 未来如需可扩展

**未使用单例模式**：
- 通过 ES 模块的自然单例特性实现
- 整个应用共享同一个 subscriptions Map
- 无需显式的 Singleton 类

**未使用异步队列模式**：
- 同步分发更简单、可预测
- 事件量小，不需要队列优化
- 避免引入复杂的异步处理逻辑

---

## 三、Module Structure and File Layout（模块结构与文件组织）

```
src/bus/
├── index.ts              # 模块入口，导出 Bus 命名空间
├── bus-event.ts          # BusEvent 命名空间，事件定义工厂
├── types.ts              # 类型定义（可选，如需复杂类型）
└── __tests__/
    └── bus.test.ts       # 单元测试
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 导出 Bus 命名空间（publish, subscribe） |
| `bus-event.ts` | 公共接口 | 导出 BusEvent 命名空间（define） |
| `types.ts` | 类型定义 | 可选，如果类型较复杂可单独文件 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `Bus.publish(event, payload)` 方法
- `Bus.subscribe(event, callback)` 方法
- `BusEvent.define(type, schema)` 方法
- `BusEvent.Definition` 类型

### 内部实现

以下内容为内部实现，可自由重构：
- `subscriptions` Map 的具体数据结构
- 错误处理和日志记录的具体实现
- 类型推断的实现细节

---

## 四、Architectural Constraints and Trade-offs（约束与权衡）

### 约束 1: 同步分发 vs 异步队列

**当前选择**：同步分发

**代价**：
- 订阅者执行时间会阻塞发布者
- 不支持优先级或延迟分发

**理由**：
- 实现简单，便于调试
- 事件量小，订阅者执行快速
- 异步场景可由订阅者自行 `setTimeout` 或 `queueMicrotask`

### 约束 2: 错误隔离策略

**当前选择**：捕获订阅者异常，记录日志，继续执行其他订阅者

**代价**：
- 订阅者异常可能被"静默"处理
- 调试时需要检查日志

**理由**：
- 保证系统稳定性，一个订阅者崩溃不影响其他
- 发布者不应关心订阅者的执行情况

**实现细节**：

```typescript
// publish() 实现伪代码
export function publish<T extends BusEvent.Definition>(
  event: T,
  payload: BusEvent.PayloadOf<T>
): void {
  const subscribers = subscriptions.get(event.type) ?? new Set()

  for (const callback of subscribers) {
    try {
      callback(payload)
    } catch (error) {
      // 使用日志模块记录错误
      Log.error('Bus: subscriber error', {
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })
      // 继续执行其他订阅者，不中断
    }
  }
}
```

**日志工具**：
- 使用 `@/util/log` 模块（参考 opencode 的 Log.create() 模式）
- 日志级别：ERROR
- 不抛出异常到发布者，不中断其他订阅者
- 包含事件类型、错误消息、堆栈信息

### 约束 3: 无事件持久化

**当前选择**：事件仅在内存中分发，不持久化

**代价**：
- 无法回放历史事件
- 订阅者必须在事件发布前注册

**理由**：
- 当前场景不需要事件溯源
- 简化实现，YAGNI 原则

### 约束 4: 字符串类型 vs 枚举类型

**当前选择**：事件类型使用字符串（如 "permission.updated"）

**代价**：
- 无法通过类型系统防止拼写错误

**理由**：
- 支持分布式事件定义
- 通过 `BusEvent.define()` 返回的对象使用，避免直接使用字符串
- 编译时通过 TypeScript 类型推断保证类型安全

---

## 五、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| once（单次订阅） | 可添加 `Bus.once()` 方法，内部自动取消订阅 |
| subscribeAll（全局订阅） | 可添加通配符支持，用于调试和日志 |
| 中间件/拦截器 | 可在 publish 流程中插入中间件链 |
| 事件历史 | 可添加可选的历史记录功能 |
| 命名空间隔离 | 可支持创建多个独立的 Bus 实例 |

---

## 六、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 架构足够简单，核心代码可控制在 100 行内
