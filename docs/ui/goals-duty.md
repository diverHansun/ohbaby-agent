# ui 模块 goals-duty.md

本文档定义 `ui` 模块的设计目标与职责边界。

**模块位置**：
- 代码：`packages/ohbaby-tui/`
- 文档：`docs/ui/`

---

## 一、模块定位

**一句话说明**：ui 模块是基于 Ink 的终端前端 surface，负责渲染 SDK snapshot/events、处理用户输入、展示补全和 dialog，并通过 `UiBackendClient` 与 backend 通信。

**如果没有这个模块**：
- 用户无法在终端中进行交互式对话。
- 模型/会话选择、permission 和 interaction 无法通过 TUI 完成。
- SDK events 缺少可视化呈现。

---

## 二、Design Goals（设计目标）

### G1: 前后端分离

UI 只依赖 `ohbaby-sdk`，不 import `ohbaby-agent`、Bus、lifecycle、commands、permission、session 或 message 内部模块。

### G2: Event-Driven Rendering

UI 通过 `getSnapshot()` 建立初始状态，通过 `subscribeEvents()` 消费增量事件并更新本地 store。

### G3: Command UX 友好

UI 使用 SDK parser/resolver 和 backend catalog 提供 slash command hints、Tab 补全和 exact execution。

### G4: Semantic Interaction

UI 根据 `interaction.requested` 的 `kind` 和 `subject` 渲染自己的 dialog/picker，例如 model selector、session selector、confirm dialog。

### G5: Surface-Owned Rendering

消息、命令结果、错误、状态栏、表格和列表的视觉呈现属于 UI。Backend 只提供结构化事件。

---

## 三、Duties（职责）

### D1: Layout 与视图

管理终端布局：
- Main content。
- Prompt 输入区。
- StatusBar。
- Dialog overlay。

### D2: 本地 UI store

维护 UI 本地状态：
- sessions 概览。
- active session。
- visible messages。
- runtime state。
- command catalog。
- pending permissions/interactions。
- prompt input state。

这些状态来自 SDK snapshot/RPC/events。

### D3: SDK event 消费

订阅并处理：
- `snapshot.replaced`
- `runtime.updated`
- `message.appended`
- `message.part.delta`
- `run.updated`
- `permission.requested`
- `command.result.delivered`
- `command.failed`
- `command.catalog.updated`
- `interaction.requested`

### D4: Slash 输入体验

负责：
- 输入时调用 SDK parser/resolver。
- 停留在 `/model` 时展示子命令/参数 hints。
- Tab 补全下一 segment。
- Enter 时只提交 exact resolved command。
- `/model` Enter 打开模型选择器。
- `/session` Enter 打开会话选择器。

### D5: DialogManager

管理 permission 和 interaction dialog 队列：
- 权限确认。
- 模型选择。
- 会话选择。
- 通用确认。

Dialog 完成后调用 `respondPermission()` 或 `respondInteraction()`。

### D6: 消息与结果渲染

渲染：
- 用户消息。
- assistant 流式文本。
- reasoning/tool call/tool result。
- command result。
- command error。
- runtime/status 信息。

---

## 四、Non-Duties（非职责）

### N1: 不执行业务逻辑

UI 不调用 lifecycle、session、message、commands、model provider 或 MCP。

### N2: 不维护 command catalog 真相

Catalog 由 backend 提供。UI 只缓存和展示。

### N3: 不做业务参数校验

UI 可以展示 `argsHint` 和补全，但参数合法性由 backend command 校验。

### N4: 不直接订阅 Bus

UI 只订阅 SDK events，不订阅 backend 内部 Bus。

### N5: 不规定非交互 stdout 输出

stdout renderer 属于 CLI 非交互 surface，不属于 TUI。

---

## 五、依赖规则

1. `packages/ohbaby-tui` 只能 import `ohbaby-sdk` 作为 backend 协议依赖。
2. TUI 不得 import `ohbaby-agent`。
3. TUI 不得使用 backend 内部事件名作为 UI 状态来源。
4. TUI 渲染 interaction 时只读取语义字段，不依赖 backend dialog 名称。

---

## 六、文档自检

- [x] UI 只作为 SDK surface 存在。
- [x] 明确排除 backend 业务依赖。
- [x] command UX 与 backend execution 边界清楚。
