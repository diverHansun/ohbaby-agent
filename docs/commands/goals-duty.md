# commands 模块 goals-duty.md

本文档定义 `commands` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`packages/ohbaby-agent/src/commands/`
- 文档：`docs/commands/`

---

## 一、模块定位

**一句话说明**：commands 模块是 backend 内部的命令目录与执行服务，负责组装 command catalog、分类、可见性、业务校验和执行，并通过后端命令事件回流语义化结果。

**如果没有这个模块**：
- 内置命令、用户命令、MCP prompt、skill/plugin 命令会散落在各处。
- UI surface 无法获得统一的 command catalog 和补全元数据。
- 命令执行无法复用 backend 的 session、model、permission、lifecycle 等能力。
- 命令结果和 interaction 无法经由统一事件协议回流到 SDK surface。

---

## 二、Design Goals（设计目标）

### G1: Backend Command Source of Truth

Backend 是 command catalog 的唯一真源，负责命令注册、分类、可见性、alias 唯一性和执行入口。

### G2: Surface Agnostic

命令逻辑不依赖 TUI、stdout、remote 或 IM channel。它只返回或发布语义化结果，不输出终端文本，不指定 UI 组件名。

### G3: Event-Driven Result Flow

命令提交后，handler 不同步返回业务结果，而是通过 `CommandRunContext` 发布后端内部事件：`Commands.Event.Started`、`Commands.Event.ResultDelivered`、`Commands.Event.Failed`。`daemon/command-events.ts` 再把这些事件投递到 stream-bridge 的 app scope，并在 SDK 侧呈现为 `command.started`、`command.result.delivered`、`command.failed`。

需要用户选择、确认或输入时，handler 调用 `runtime/interaction-broker`，broker 发布 `Interaction.Event.Requested`，最终在 SDK 侧呈现为 `interaction.requested`。

### G4: Clear Parameter Boundary

SDK 负责词法解析并提供 `rawArgs`/`argv`；commands 负责领域参数校验和业务错误。V1 不要求 SDK 执行 schema 校验。

### G5: Conservative Execution

命令执行必须 exact catalog match。补全可以智能，执行不做 `/model xxx -> /model switch xxx` 这类推断。

---

## 三、Duties（职责）

### D1: Command catalog 组装

从内置命令、用户命令、MCP prompt、skill/plugin 等来源加载命令，生成 `UiCommandSpec[]`。

V1 至少包含内置命令；其他 loader 可预留但不强制实现。

### D2: 命令分类与可见性

为每个命令声明：
- canonical `id` 和 `path`。
- `category`。
- `description` 和 `argsHint`。
- `source`。
- `surfaces`。
- `aliases`。
- parent command 默认行为。

### D3: Alias 管理

支持 alias，但 alias 只能来自 catalog。commands 模块必须保证 alias 全局唯一，不允许一个 alias 指向多个命令。

### D4: 命令执行

接收已 resolved 的 `UiCommandInvocation`，执行对应 backend command handler。

命令执行期间可以调用 session、message、model provider、permission、MCP、memory、context、lifecycle 等 backend 服务。

### D5: 语义化 interaction

当命令需要用户输入时，通过 `runtime/interaction-broker` 请求语义化 interaction：
- MVP 中 `/model` 只展示当前单模型配置，不请求选择器。
- `/session` 无参数时请求 `select-one:session`，接受后切换 active session。
- backend 不指定 `ModelDialog` 或 `SessionDialog` 这类 UI 组件名。

### D6: 参数校验

根据命令语义校验 `argv` 或 `rawArgs`，并在失败时发布 `command.failed`，错误码如 `INVALID_ARGS`。

### D7: 后端事件发布

命令执行必须通过 `CommandRunContext` 发布后端内部事件。commands 不直接调用 stream-bridge，不直接构造 TUI 输出，也不直接面向 SDK client 写入事件流。

事件翻译职责位于 `runtime/daemon/command-events.ts`：它订阅 `Commands.Event.*` 和 `Interaction.Event.*`，发布到 stream-bridge 的 app scope。Bus 事件不得直接暴露给 UI。

### D8: 内置命令族

V1 内置命令族：

| 分类 | 命令 |
|------|------|
| model | `/model`, `/model list`, `/model current` |
| session | `/session`, `/session list` |
| system | `/status`, `/tools`, `/abort`, `/exit` |

---

## 四、Non-Duties（非职责）

### N1: 不负责 slash 词法解析

`parseSlashInput()` 和 `resolveCommand()` 属于 `ohbaby-sdk`。commands 不解析原始输入框文本。

### N2: 不负责 UI 渲染

commands 不输出表格、颜色、列表、dialog 或 picker。UI surface 决定如何渲染 SDK 事件。

### N3: 不负责 provider alias

模型切换中，`provider` 不允许 alias。commands 只接受 canonical provider，输入大小写不敏感，canonical 输出全小写。

### N4: 不负责模型选择 UI 或模型切换

MVP 中 commands 只报告当前模型配置，例如 `/model` 和 `/model current` 输出 `model.current` 数据；不请求模型选择 interaction，也不实现模型切换 UI。未来如果加入模型切换，仍必须通过语义化 interaction 事件，而不是依赖具体 TUI 组件。

### N5: 不维护输入历史

命令历史、输入框状态、Tab 补全 UI 属于 frontend surface。

### N6: 不直接暴露内部 Bus

commands 可以使用 backend 内部 Bus，但 UI 只能看到 SDK 事件。

---

## 五、硬性依赖规则

1. commands 不得 import `ohbaby-tui`。
2. commands 不得依赖 TUI dialog 名称。
3. commands 输出必须能被 TUI、stdout、remote/headless surface 消费。
4. command catalog 中的 `provider` 参数不支持 alias。
5. model-id 可以支持 provider 内 alias，但执行结果和状态存储必须使用 canonical model id。
6. commands 不得 import `runtime/stream-bridge`；事件只能通过内部 event sink/Bus 进入 daemon 翻译层。

---

## 六、文档自检

- [x] commands 的职责限定为 backend catalog 和执行。
- [x] SDK parser 与 UI renderer 均排除在外。
- [x] interaction 使用语义而非 UI 组件名。
