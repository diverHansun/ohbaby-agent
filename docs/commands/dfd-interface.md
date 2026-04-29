# commands 模块 dfd-interface.md

本文档描述 `commands` 模块与外部模块的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

commands 模块位于 backend 内部，接收 SDK command invocation，调用 backend 服务，并发布后端内部命令事件。`runtime/daemon/command-events.ts` 负责把这些事件投递到 stream-bridge 的 app scope，SDK client 再消费为 `command.*` / `interaction.*` 事件。

```
UI surface
  │ executeCommand(invocation)
  ▼
UiBackendClient adapter
  │
  ▼
CommandService
  │
  ├─ backend services: session/model/mcp/memory/context/permission/lifecycle
  ├─ runtime/interaction-broker
  │
  ▼
Commands.Event.* / Interaction.Event.*
  │
  ▼
daemon/command-events.ts
  │
  ▼
stream-bridge app scope
  │
  ▼
SDK UiEvent
```

本文档不描述 SDK parser 的实现，也不描述 UI 如何渲染事件。

---

## 二、Data Flow Description（数据流描述）

### 2.1 Catalog 获取

1. UI 连接后调用 `listCommands(surface)`。
2. Backend adapter 调用 CommandService。
3. CommandService 从当前 catalog 过滤 surface 可见命令。
4. Backend 返回 `UiCommandSpec[]` 和 catalog version。

### 2.2 Catalog 更新

1. loader 因配置、MCP、plugin 或用户命令 reload 更新 catalog。
2. CommandService 校验 path 和 alias 唯一性。
3. CommandService 发布内部 catalog updated 事件。
4. `daemon/command-events.ts` 投递 SDK 协议事件 `command.catalog.updated`。
5. UI 重新调用 `listCommands(surface)`。

### 2.3 普通命令执行

1. UI 通过 SDK resolver 得到 canonical command。
2. UI 调用 `executeCommand(invocation)`。
3. Backend adapter 分配/记录 `commandRunId`，调用 `CommandService.invoke(invocation, ctx)`。
4. CommandRunContext 发布 `Commands.Event.Started`。
5. Handler 校验参数并调用 backend 服务。
6. Handler 通过 `ctx.emitOutput()`、`ctx.emitAction()` 或 `ctx.fail()` 发布内部事件。
7. `daemon/command-events.ts` 把内部事件投递到 stream-bridge app scope。
8. SDK client 消费为 `command.result.delivered` 或 `command.failed`。

### 2.4 Interaction 命令执行

1. `/model` 或 `/model switch` 无参数时进入 model selection flow。
2. Handler 调用 `ctx.requestInteraction()`。
3. `runtime/interaction-broker` 创建 pending interaction，并发布 `Interaction.Event.Requested`。
4. `daemon/command-events.ts` 投递：

```text
interaction.requested {
  kind: "select-one",
  subject: "model",
  options: [...]
}
```

5. TUI 渲染 provider + model 选择器。
6. UI 调用 `respondInteraction(interactionId, response)`。
7. InteractionBroker resolve pending promise，handler 恢复并完成模型切换。
8. Backend 发布最终 command result。

### 2.5 参数错误

1. Handler 根据命令规则校验 `argv`/`rawArgs`。
2. 参数不合法时发布 `command.failed`。
3. 例如非交互调用 `/model switch` 无参数，返回：

```text
INVALID_ARGS: /model switch <provider> <model-id>
```

---

## 三、Interface Definition（接口定义）

### CommandService

| 接口 | 语义 |
|------|------|
| `listCommands(surface)` | 返回 surface 可见 catalog |
| `invoke(invocation, context)` | 接收 resolved invocation，创建/使用 CommandRunContext 并执行 handler |
| `reloadCatalog(reason)` | 重新加载并发布 catalog update |

### CommandRunContext

| 接口 | 语义 |
|------|------|
| `emitOutput(output)` | 发布命令输出事件 |
| `emitAction(action)` | 发布命令动作事件 |
| `fail(error)` | 发布命令失败事件 |
| `requestInteraction(req)` | 通过 InteractionBroker 请求用户交互并等待 response |

### Backend service dependencies

| 服务 | 用途 |
|------|------|
| Model provider registry | `model.list/current/switch` |
| Session service | `session.list/choose/clear` |
| Message service | session 切换和统计 |
| MCP service | `mcp.list/auth/refresh` |
| Policy/Agent service | `agents.mode/list` |
| Memory service | `memory.show/add/refresh` |
| Context service | `compact/status` |
| Permission/Lifecycle | `approval-mode/abort` |
| runtime/interaction-broker | `requestInteraction/abort/respond` |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 责任 |
|------|--------|------|
| Command catalog | CommandService | 真源、版本、分类、alias |
| Command invocation | UI/SDK | 提交 canonical command |
| Business state | 各 backend service | commands 只协调，不持久化 |
| Commands.Event.* | CommandRunContext | 语义化输出、动作、失败 |
| Interaction.Event.* | InteractionBroker | 等待、恢复、取消 |
| SDK command event | daemon/command-events.ts | 后端事件到 stream-bridge app scope 的投递 |

---

## 五、错误处理策略

| 错误 | 处理 |
|------|------|
| catalog alias 冲突 | catalog 构建失败，记录 backend error |
| command 不存在 | 正常情况下 SDK resolver 已拦截；backend 仍返回 `COMMAND_NOT_FOUND` |
| 参数无效 | `command.failed` + `INVALID_ARGS` |
| backend 服务失败 | `command.failed` + `EXECUTION_ERROR` |
| interaction 取消 | handler 按命令语义取消或回滚 |
| command abort | abort signal 触发，pending interaction 被 broker 拒绝，发布 `command.failed` 或取消语义 |

---

## 六、文档自检

- [x] 数据流围绕 catalog、execution、interaction 展开。
- [x] 所有接口都能映射到数据流。
- [x] 数据所有权没有落到 UI。
