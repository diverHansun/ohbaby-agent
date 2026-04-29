# ohbaby-sdk 模块 data-model.md

本文档描述 `ohbaby-sdk` 模块的核心抽象与数据模型。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| UiBackendClient | UI surface 调用 backend 的协议接口 |
| UiSnapshot | UI 首屏和恢复所需的当前状态快照 |
| UiEvent | backend 向 UI 推送的增量事件 |
| UiCommandSpec | backend 下发的命令目录项 |
| UiCommandInvocation | UI 提交给 backend 的命令调用 |
| UiInteractionRequest | backend 请求 UI 完成的语义化交互 |

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| UiSnapshot | Value Object | 当前状态的只读快照 |
| UiEvent | Value Object | 一次性事件，发布后不可变 |
| UiCommandSpec | Value Object | catalog 中的命令描述 |
| UiCommandInvocation | Value Object | 一次命令提交 |
| UiInteractionRequest | Entity-like DTO | 具有 `interactionId`，需要后续 response |

SDK 本身不管理这些对象的生命周期。生命周期归 backend 或 UI 本地 store。

---

## 三、Key Data Fields（关键数据字段）

### 3.1 UiCommandSpec

| 字段 | 含义 |
|------|------|
| `id` | 稳定命令 ID，如 `model.switch` |
| `path` | 多级 slash 路径，如 `["model", "switch"]` |
| `aliases` | catalog 声明的别名路径 |
| `category` | backend 分类，用于 UI 分组 |
| `description` | 命令说明 |
| `argsHint` | 参数提示，如 `<provider> <model-id>` |
| `argumentMode` | `raw` / `argv` / `structured` |
| `source` | `builtin` / `user` / `mcp` / `skill` / `plugin` |
| `surfaces` | 可暴露的 surface 列表 |
| `parentBehavior` | 父命令 Enter 后的行为 |

### 3.2 UiCommandInvocation

| 字段 | 含义 |
|------|------|
| `clientInvocationId` | UI 生成的提交关联 ID |
| `commandId` | resolved command id |
| `path` | canonical command path |
| `raw` | 原始用户输入 |
| `rawArgs` | 未解析参数文本 |
| `argv` | shell-like 切分后的参数 |
| `sessionId` | 当前会话 ID，可选 |
| `surface` | 发起命令的 UI surface |

### 3.3 UiInteractionRequest

| 字段 | 含义 |
|------|------|
| `interactionId` | backend 生成的交互 ID |
| `clientInvocationId` | 对应的命令提交 ID，可选 |
| `kind` | `select-one` / `select-many` / `confirm` / `text-input` |
| `subject` | `model` / `session` / `permission-policy` 等语义主题 |
| `options` | 可选项数据，由 UI 自行渲染 |

Backend 不指定 `ModelDialog` 之类 UI 组件名，只描述交互语义。

### 3.4 UiEvent 命名空间

事件使用点分命名：

| 命名空间 | 示例 |
|----------|------|
| `snapshot.*` | `snapshot.replaced` |
| `runtime.*` | `runtime.updated` |
| `message.*` | `message.appended`, `message.part.delta` |
| `run.*` | `run.updated` |
| `permission.*` | `permission.requested`, `permission.resolved` |
| `command.*` | `command.started`, `command.result.delivered`, `command.catalog.updated` |
| `interaction.*` | `interaction.requested`, `interaction.resolved` |

---

## 四、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 更新者 | 说明 |
|------|--------|--------|------|
| UiSnapshot | backend adapter | backend adapter | UI 只读取 |
| UiCommandSpec | backend CommandService | backend CommandService | UI/SDK 只消费 |
| UiCommandInvocation | UI surface | - | backend 消费 |
| UiInteractionRequest | backend command runtime | backend command runtime | UI 通过 response 完成 |
| UiEvent | backend adapter | - | UI 订阅并更新本地状态 |

---

## 五、与其他模块的概念边界

| 概念 | SDK 视角 | Backend 视角 | UI 视角 |
|------|----------|--------------|---------|
| command | 可解析、可匹配的 catalog item | 可执行的业务入口 | 可展示、可补全的用户动作 |
| interaction | 语义化请求 | 暂停并等待用户输入 | dialog、picker 或 inline prompt |
| result | 事件 payload | command 执行输出 | 渲染材料 |

---

## 六、文档自检

- [x] 所有概念均用于协议层。
- [x] 区分了 SDK DTO 与 backend 内部实体。
- [x] interaction 没有泄漏 UI 组件名。
