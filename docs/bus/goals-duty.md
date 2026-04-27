# bus 模块 goals-duty.md

本文档定义 `bus` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：bus 模块是 ohbaby-code 的事件通信基础设施，提供类型安全的发布/订阅机制，让模块间通过事件而非直接调用进行通信。

**如果没有这个模块**：
- Permission 模块需要直接调用 UI 层代码显示确认框（耦合）
- Policy 模块需要直接调用 UI 层代码更新状态指示器（耦合）
- Message 模块更新后无法通知 UI 层实时刷新
- 模块间需要互相持有引用才能通知对方状态变化（复杂依赖）
- 难以支持多种 UI 实现（CLI、IDE 扩展等）

---

## 二、Design Goals（设计目标）

### G1: 简单至上

提供最小化的 API：`publish`、`subscribe`，不引入复杂的消息队列、路由或中间件概念。实现代码应控制在 100 行以内。

### G2: 类型安全

通过 Zod schema 定义事件类型，在编译时和运行时都能保证事件 payload 类型正确。事件定义由各业务模块自行维护，Bus 模块不知道任何业务事件的存在。

### G3: 完全解耦

发布者和订阅者互不感知，通过事件类型进行匹配。业务模块只依赖 Bus 模块，不依赖其他业务模块。

### G4: 分布式事件定义

事件类型由各业务模块自行定义（如 `Permission.Event.Updated`），Bus 模块只提供 `BusEvent.define()` 工厂函数，不维护事件类型清单。新增事件无需修改 Bus 模块。

### G5: 同步分发

事件发布时同步调用所有订阅者，不引入异步队列或事件循环。简化实现，便于调试和理解。

---

## 三、Duties（职责）

### D1: 提供事件定义工厂

提供 `BusEvent.define(type, schema)` 函数，用于创建类型安全的事件定义。事件定义包含事件类型字符串和 Zod schema。

### D2: 管理订阅者注册

维护订阅者列表，支持按事件类型注册订阅者。同一事件类型可有多个订阅者。

### D3: 分发事件

当事件发布时，查找所有匹配的订阅者并调用其回调函数，传入事件 payload。

### D4: 支持取消订阅

`subscribe()` 返回取消订阅函数，调用方可在适当时机取消订阅，避免内存泄漏。

### D5: 错误隔离

单个订阅者的异常不影响其他订阅者的执行。捕获订阅者异常并记录日志，继续执行其他订阅者。

---

## 四、Non-Duties（非职责）

### N1: 不定义业务事件类型

业务事件（如 `Permission.Event.Updated`、`Message.Event.Updated`）由各业务模块自行定义和维护。Bus 模块不导入、不维护、不知道任何业务事件的存在。

### N2: 不包含业务逻辑

Bus 模块只做事件的发布和分发，不在发布过程中执行任何业务逻辑（如策略决策）。这与 Gemini-CLI 的 MessageBus 设计不同。

### N3: 不持久化事件

事件仅在内存中分发，不存储历史事件。不提供事件重放、事件溯源等功能。

### N4: 不保证订阅者执行顺序

同一事件的多个订阅者按注册顺序调用，但不做顺序保证。订阅者不应依赖执行顺序。

### N5: 不支持跨进程通信和跨实例传播

Bus 模块仅限单进程内使用，不支持多进程、多机器间的事件传播。

同时，Bus 模块仅限单项目实例内使用，不实现类似 opencode 的 GlobalBus 机制用于跨实例事件传播。

**理由**：
- MVP 阶段单项目场景，无跨实例需求
- 跨实例通信可在未来通过独立的 GlobalBus 模块实现
- 保持 Bus 模块简单（YAGNI 原则）

**opencode 的 GlobalBus 实现参考**：
```typescript
// opencode 使用 GlobalBus 在不同 instance 间传播事件
export const GlobalBus = new EventEmitter<{
  event: [{ directory?: string; payload: any }]
}>()

// 在 Bus.publish 中同时发送到 GlobalBus
GlobalBus.emit("event", { directory: Instance.directory, payload })
```

### N6: 不实现 Request-Response 模式

Bus 只提供单向的发布/订阅，不内置请求-响应模式。需要该模式的模块（如 Permission）自行实现 pending Promise 机制。

### N7: 不提供事件过滤或路由

所有匹配事件类型的订阅者都会收到事件，不支持基于 payload 内容的过滤或路由。

---

## 五、设计约束与假设

### 约束

1. **单进程运行**：当前版本假设单进程环境，不处理跨进程事件
2. **同步分发**：publish 时同步调用所有订阅者，不引入异步队列
3. **无异常传播**：订阅者抛出的异常被捕获，不影响其他订阅者和发布者
4. **事件类型唯一**：同一事件类型字符串只能有一个定义，重复定义行为未定义
5. **单项目实例**：MVP 阶段假设单项目场景，使用全局单例 subscriptions Map。多项目场景（如 VS Code workspace 多文件夹）暂不支持。未来可通过 Instance.state() 模式（参考 opencode）实现实例隔离

### 假设

1. 事件量较小（每秒几十个级别），不需要性能优化
2. 订阅者数量有限（每种事件通常 1-3 个订阅者）
3. 业务模块会正确使用 Zod schema 定义事件类型
4. 调用方会在适当时机调用取消订阅函数，避免内存泄漏

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| Message | 被依赖 | Message 使用 Bus 广播消息更新事件 |
| Permission | 被依赖 | Permission 使用 Bus 广播权限请求和响应事件 |
| Policy | 被依赖 | Policy 使用 Bus 发布模式变化事件，订阅 Permission 的模式切换请求 |
| CLI/UI 层 | 被依赖 | UI 层订阅各模块事件以实时更新显示 |
| Lifecycle | 间接依赖 | Lifecycle 通过 Message 模块间接使用 Bus（消息更新事件） |
| Commands | 被依赖（未来） | Commands 可能使用 Bus 广播命令执行事件 |

### 依赖图

```
                    ┌─────────────────┐
                    │       Bus       │
                    │  (事件总线)      │
                    └─────────────────┘
                           ▲
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────┴─────┐   ┌──────┴─────┐   ┌──────┴─────┐
    │  Message  │   │ Permission │   │   Policy   │
    │ (发布者)   │   │(发布/订阅) │   │(发布/订阅) │
    └───────────┘   └────────────┘   └────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           ▼
                    ┌─────────────────┐
                    │    CLI / UI     │
                    │   (订阅者)       │
                    └─────────────────┘
```

---

## 七、与 Gemini-CLI MessageBus 的设计差异

ohbaby-code 的 Bus 模块与 Gemini-CLI 的 MessageBus 在设计哲学上有本质差异：

| 特性 | Gemini-CLI MessageBus | ohbaby-code Bus |
|------|----------------------|---------------|
| **策略集成** | 内置 PolicyEngine，publish 时执行策略决策 | 纯事件总线，不包含业务逻辑 |
| **Request-Response** | 内置 correlationId 和 request() 方法 | 单向发布订阅，由业务模块实现 |
| **事件类型定义** | 枚举定义（MessageBusType.TOOL_CONFIRMATION_REQUEST） | 分布式定义（业务模块自行定义） |
| **复杂度** | 约 200 行，包含策略逻辑和请求-响应模式 | 约 100 行，纯事件分发 |
| **职责** | 确认总线 + 策略决策器 + 事件总线的混合 | 单一职责：事件分发 |

### Gemini-CLI MessageBus 的实现特点

```typescript
// Gemini-CLI 在 publish 中内置策略决策
async publish(message: Message): Promise<void> {
  if (message.type === MessageBusType.TOOL_CONFIRMATION_REQUEST) {
    const { decision } = await this.policyEngine.check(message.toolCall)

    switch (decision) {
      case PolicyDecision.ALLOW:
        this.emitMessage({ type: TOOL_CONFIRMATION_RESPONSE, confirmed: true })
        break
      case PolicyDecision.DENY:
        this.emitMessage({ type: TOOL_POLICY_REJECTION })
        break
      case PolicyDecision.ASK_USER:
        this.emitMessage(message)  // 传递给 UI
        break
    }
  }
}

// 内置请求-响应模式
async request<TRequest, TResponse>(
  request: TRequest,
  responseType: TResponse['type'],
  timeout: number
): Promise<TResponse>
```

### ohbaby-code 的设计理由

**为什么不采用 Gemini-CLI 的混合模式**：

1. **违反 SRP**：MessageBus 同时承担事件总线、策略决策、请求-响应三个职责
2. **耦合度高**：Bus 需要了解 PolicyEngine、ToolCall 等业务概念
3. **扩展困难**：新增业务逻辑需要修改 Bus 模块
4. **测试复杂**：需要 mock PolicyEngine 才能测试事件分发

**ohbaby-code 的分离设计**：

- **Bus 模块**：纯粹的事件分发，不知道业务逻辑
- **Policy 模块**：订阅 Permission 事件，执行策略决策
- **Permission 模块**：自行实现请求-响应模式（pending Promise）

这种设计遵循 KISS（简单至上）和 SRP（单一职责）原则，每个模块职责清晰，易于测试和扩展。

---

## 八、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] Non-Duties 明确区分了与 Gemini-CLI MessageBus 的设计差异
- [x] 明确了实例隔离策略和跨实例通信的约束
- [x] 集中说明了与 Gemini-CLI 的核心设计差异及理由
