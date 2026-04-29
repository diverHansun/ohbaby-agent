# commands 模块 architecture.md

本文档描述 `commands` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的职责边界。

---

## 一、Architecture Overview（总体架构）

commands 模块采用 `CommandService + Loader + CommandRunContext` 结构，事件经由 daemon 翻译层进入 SDK 协议：

```
SDK UiCommandInvocation
        │
        ▼
UiBackendClient adapter
        │
        ▼
┌──────────────────────────────────────────────┐
│              CommandService                  │
│  catalog · visibility · alias · execution    │
└───────────────┬──────────────────────────────┘
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
BuiltinLoader FileLoader McpPromptLoader ...
     │
     ▼
CommandHandler.execute(args, CommandRunContext)
     │
     ├─ emitOutput / emitAction / fail
     │     → Commands.Event.*
     │
     └─ requestInteraction(...)
           → runtime/interaction-broker
           → Interaction.Event.*

Commands.Event.* / Interaction.Event.*
        │
        ▼
daemon/command-events.ts
        │
        ▼
stream-bridge app scope
        │
        ▼
SDK UiEvent: command.* / interaction.*
```

CommandService 有两条主要路径：

1. Catalog path：加载、分类、过滤、下发 `UiCommandSpec[]`。
2. Execution path：接收 resolved invocation，执行业务 handler，并发布后端内部命令事件。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Loader Pattern

命令来源通过 loader 接入：
- BuiltinLoader：内置命令。
- FileLoader：用户命令，V2。
- McpPromptLoader：MCP prompt，V2。
- PluginLoader：plugin 命令，V2。

**理由**：命令发现与执行分离，符合开放封闭原则。

### 2. Flat Catalog + Derived Tree

Backend 内部可以用树组织命令，但对 SDK 下发 flat catalog。

**理由**：
- flat catalog 易序列化、去重、版本化。
- UI 可用 SDK helper 派生 tree/hints。
- 多级命令仍由 `path: string[]` 表达。

### 3. CommandRunContext

Command handler 不返回业务结果，也不直接发布 SDK events。每个 handler 只接收 `ResolvedArgs` 和 `CommandRunContext`：

```typescript
interface CommandHandler {
  id: string
  execute(args: ResolvedArgs, ctx: CommandRunContext): Promise<void>
}

interface CommandRunContext {
  commandRunId: string
  clientInvocationId: string
  sessionId?: string
  signal: AbortSignal
  emitOutput(output: UiCommandOutput): void
  emitAction(action: UiCommandAction): void
  fail(error: UiCommandError): void
  requestInteraction(
    req: Omit<UiInteractionRequest, 'interactionId'>
  ): Promise<UiInteractionResponse>
}
```

`CommandRunContext` 内部负责生成 `Commands.Event.*`，并保证一个 command run 的终态事件只发布一次。

**理由**：interaction 本身需要暂停/恢复；统一用事件流表达结果，可以避免"短命令同步返回、长命令异步事件"两套语义。

### 4. Interaction Request

需要用户选择时，handler 调用 `ctx.requestInteraction()` 并等待 response。实际 pending request、abort 和 resume 由 `runtime/interaction-broker` 管理。

**理由**：与 permission 流程同构，避免同步返回和异步等待混用。

### 5. Daemon Event Projection

commands 只产生后端内部事件，不直接依赖 stream-bridge。`daemon/command-events.ts` 与 `daemon/app-events.ts` 平行存在，专门订阅：

- `Commands.Event.*`
- `Interaction.Event.*`

它将这些事件发布到 stream-bridge 的 app scope，事件名保持 SDK 协议语义，例如 `command.started`、`command.result.delivered`、`interaction.requested`。

**理由**：commands 保持业务模块边界，stream-bridge 保持传输层边界，SDK 事件命名不反向污染 backend handler。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-agent/src/commands/
├── index.ts
├── types.ts                   # CommandHandler / ResolvedArgs / command event types
├── service.ts                 # CommandService
├── catalog.ts                 # catalog build/filter/version
├── aliases.ts                 # alias 唯一性校验
├── execution.ts               # invocation dispatch
├── run-context.ts             # CommandRunContext implementation
├── events.ts                  # Commands.Event.* 定义与发布工具
├── loaders/
│   ├── types.ts
│   └── builtin.ts
├── builtin/
│   ├── model.ts
│   ├── session.ts
│   ├── mcp.ts
│   ├── agents.ts
│   ├── memory.ts
│   ├── status.ts
│   ├── compact.ts
│   ├── init.ts
│   ├── tools.ts
│   ├── approval-mode.ts
│   ├── stats.ts
│   ├── abort.ts
│   └── exit.ts
└── templates/
    └── init.md
```

### 对外稳定接口

- `listCommands(surface)`。
- `invoke(invocation, context): Promise<void>`。
- Command catalog 事件。

### 内部实现

- loader 的具体加载方式。
- handler 内部调用哪些 backend service。
- `CommandRunContext` 如何发布 `Commands.Event.*`。
- interaction response 如何由 `runtime/interaction-broker` 恢复等待中的 handler。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: 执行 exact match

**当前选择**：CommandService 只执行 SDK resolver 已匹配的 canonical command。

**放弃方案**：`/model gpt-5.5` 自动推断为 `/model switch gpt-5.5`。

**代价**：少一个快捷输入。

**理由**：状态变更命令必须可预期。

### 约束 2: Provider 无 alias，model-id 可 provider 内 alias

**当前选择**：`/model switch <provider> <model-id>` 中 provider 必须是 canonical provider；model-id 可由该 provider catalog 解析 alias。

**代价**：用户不能输入 `claude`、`oai` 这类 provider 昵称。

**理由**：provider 通常是商业公司或项目名称，应保持稳定原名。

### 约束 3: Catalog 不放 snapshot

**当前选择**：catalog 通过专项 RPC 拉取，变化时发布 `command.catalog.updated`。

**代价**：UI 初次连接多一次请求。

**理由**：catalog 低频变化，不应膨胀 snapshot。

### 约束 4: commands 不直接投递 stream

**当前选择**：commands 只发布 `Commands.Event.*`。`daemon/command-events.ts` 负责把命令/交互事件投递到 stream-bridge 的 app scope。

**代价**：多一个 daemon 内部接线文件。

**理由**：CommandService 不应知道客户端传输层；stream-bridge 也不应订阅业务 Bus。daemon 是组合根，最适合持有这层映射。

### 约束 5: Help 不作为每个命令的子命令

**当前选择**：输入时展示 hints，Tab 做补全；不为每个父命令添加 help 子命令。

**代价**：文档型帮助集中在全局说明中。

**理由**：避免后续所有命令都膨胀出 help 变体。
