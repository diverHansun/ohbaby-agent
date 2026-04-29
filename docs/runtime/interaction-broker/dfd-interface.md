# interaction-broker 模块 dfd-interface.md

本文档描述 `runtime/interaction-broker` 模块与外部模块的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

interaction-broker 只处理 backend 内部的 pending interaction lifecycle：

```
commands / CommandRunContext
  │ requestInteraction(req)
  ▼
InteractionBroker
  │ Interaction.Event.*
  ▼
daemon/command-events.ts
  ▼
stream-bridge app scope
  ▼
SDK client
  │ respondInteraction(id, response)
  ▼
UiBackendClient adapter
  ▼
InteractionBroker
```

本文档不描述 TUI 如何渲染 dialog，也不描述 permission 请求。

---

## 二、Data Flow Description（数据流描述）

### 2.1 请求 interaction

1. Command handler 调用 `ctx.requestInteraction(req)`。
2. CommandRunContext 调用 `InteractionBroker.request(req, context)`。
3. Broker 生成 `interactionId`。
4. Broker 写入 pending map。
5. Broker 发布 `Interaction.Event.Requested`。
6. `request()` 返回 pending Promise，handler 暂停等待。

### 2.2 响应 interaction

1. SDK surface 调用 `respondInteraction(interactionId, response)`。
2. UiBackendClient adapter 调用 `InteractionBroker.respond()`。
3. Broker 找到 pending entry。
4. Broker resolve Promise。
5. Broker 删除 pending entry。
6. Broker 发布 `Interaction.Event.Resolved`。
7. Handler 恢复执行并继续发布 command result。

### 2.3 用户取消

1. SDK surface 发送 `{ kind: "cancelled", reason: "user-cancelled" }`。
2. Broker resolve Promise，而不是把取消静默吞掉。
3. Handler 根据命令语义决定发布取消消息、失败事件或无输出返回。

### 2.4 command abort

1. command run 收到 abort signal。
2. CommandRunContext 或 CommandService 调用 `abortByCommandRun(commandRunId, reason)`。
3. Broker 取消该 command run 下所有 pending interactions。
4. Handler 收到 cancelled response 或 promise rejection。
5. CommandRunContext 发布明确的 command 终态事件。

---

## 三、Interface Definition（接口定义）

| 接口 | 语义 |
|------|------|
| `request(req, context)` | 创建 pending interaction，发布 requested 事件，返回 response Promise |
| `respond(interactionId, response)` | 响应 pending interaction，发布 resolved 事件 |
| `abortByCommandRun(commandRunId, reason)` | 取消某个 command run 下所有 pending interactions |
| `abortAll(reason)` | daemon stop 或全局清理时取消全部 pending interactions |
| `listPending()` | 测试/诊断使用，返回只读 pending 摘要 |

---

## 四、错误处理策略

| 场景 | 处理 |
|------|------|
| unknown interactionId | 返回 `INTERACTION_NOT_FOUND`，不创建新 pending |
| duplicate response | 第一条 response 生效，后续返回 `INTERACTION_NOT_FOUND` 或 `ALREADY_RESOLVED` |
| response shape 与 request kind 不匹配 | 返回 `INVALID_INTERACTION_RESPONSE` |
| command abort | pending response 变为 cancelled 或 promise rejection，由 handler 转为 command 终态 |
| daemon stop | `abortAll()`，不留下悬挂 promise |

---

## 五、文档自检

- [x] request/respond/abort 三条主路径完整。
- [x] broker 不直接面向 TUI 或 stream-bridge。
- [x] 取消和 abort 都有明确语义。
