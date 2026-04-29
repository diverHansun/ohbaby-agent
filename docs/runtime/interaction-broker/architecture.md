# interaction-broker 模块 architecture.md

本文档描述 `runtime/interaction-broker` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的职责边界。

---

## 一、Architecture Overview（总体架构）

interaction-broker 位于 command handler 与 SDK surface 之间，负责 pending interaction 的生命周期：

```
CommandHandler
  │ await ctx.requestInteraction(req)
  ▼
CommandRunContext
  │
  ▼
InteractionBroker
  ├─ generate interactionId
  ├─ pendingInteractions.set(...)
  ├─ publish Interaction.Event.Requested
  └─ await response
        ▲
        │ respondInteraction(interactionId, response)
        │
UiBackendClient adapter
```

事件输出路径：

```
InteractionBroker
  │ Interaction.Event.Requested / Resolved
  ▼
daemon/command-events.ts
  ▼
stream-bridge app scope
  ▼
SDK UiEvent: interaction.requested / interaction.resolved
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Broker Pattern

InteractionBroker 是 pending request 的唯一协调者。调用方只获得 Promise，不直接访问 pending map。

**理由**：暂停/恢复、超时、abort、重复响应这些边界条件必须集中处理，否则每个 command handler 都会实现一份微妙不同的状态机。

### 2. Shared Pending Registry Utility

broker 内部可使用通用 `PendingRequestRegistry`：

```typescript
interface PendingRequestRegistry<TResponse> {
  create(entry): { id: string; promise: Promise<TResponse> }
  resolve(id: string, response: TResponse): boolean
  rejectByOwner(ownerId: string, error: Error): number
  clear(error: Error): number
}
```

**理由**：permission 也有类似的 pending request 模式，但模块语义不应合并。共享底层 registry，保留上层业务边界。

### 3. Event Projection Outside Broker

broker 发布 `Interaction.Event.*` 内部事件，不直接调用 stream-bridge。

**理由**：broker 是 runtime 基础设施，不是传输层。daemon 是组合根，负责把内部事件投递到 bridge。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-agent/src/runtime/interaction-broker/
├── index.ts
├── broker.ts                 # InteractionBroker
├── pending-registry.ts       # 可复用 pending request registry
├── events.ts                 # Interaction.Event.* 定义
├── types.ts                  # request/response/pending entry 类型
└── __tests__/
    ├── broker.test.ts
    └── pending-registry.test.ts
```

### 对外稳定接口

- `request(req, context): Promise<UiInteractionResponse>`。
- `respond(interactionId, response)`。
- `abortByCommandRun(commandRunId, reason)`。
- `abortAll(reason)`。

### 内部实现

- `interactionId` 生成方式。
- pending map 的数据结构。
- abort 时返回 cancelled response 还是 reject promise 的具体实现。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: interaction 与 permission 不合并

**当前选择**：interaction-broker 和 permission 模块平行存在。

**代价**：两个模块都有 pending request 模型。

**理由**：permission 的核心是授权策略、审计和记忆；interaction 的核心是用户选择/输入。合并会让 permission 语义污染普通 UI 选择器。

### 约束 2: broker 不创建 SDK event

**当前选择**：broker 只发内部 `Interaction.Event.*`。

**代价**：需要 `daemon/command-events.ts` 做投递。

**理由**：保持 runtime 业务协调层与传输/协议投影层分离。

### 约束 3: pending interaction 不持久化

**当前选择**：daemon 重启后 pending interaction 全部失效。

**代价**：client 断线过久后需要重新执行命令或由 snapshot 呈现可恢复状态。

**理由**：interaction 是执行栈中的暂停点，持久化会要求恢复 handler call stack，复杂度过高。
