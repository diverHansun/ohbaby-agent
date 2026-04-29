# ui 模块 data-model.md

本文档描述 `ui` 模块的核心抽象与数据模型。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| TuiStore | SDK snapshot/events 在 TUI 内的本地投影 |
| PromptState | 输入框文本、光标、历史和补全状态 |
| CommandCatalogState | 当前 surface 可见 command catalog |
| DialogState | 当前和排队中的 permission/interaction |
| RuntimeViewState | 状态栏和加载状态所需的 runtime 数据 |

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| TuiStore | UI State | 由 SDK 数据投影而来 |
| PromptState | UI State | 用户输入生命周期内变化 |
| CommandCatalogState | Value Object Cache | 后端 catalog 的本地缓存 |
| DialogState | UI State | 包含当前 dialog 和队列 |
| RuntimeViewState | View Model | 从 SDK runtime events 派生 |

---

## 三、Key Data Fields（关键数据字段）

### 3.1 CommandCatalogState

| 字段 | 含义 |
|------|------|
| `version` | backend catalog version |
| `commands` | `UiCommandSpec[]` |
| `surface` | `tui` |
| `loadedAt` | 本地加载时间 |

### 3.2 PromptState

| 字段 | 含义 |
|------|------|
| `value` | 输入文本 |
| `history` | 本地输入历史 |
| `completion` | 当前补全候选 |
| `hint` | 当前 path/args 提示 |
| `mode` | normal / command |

### 3.3 DialogState

| 字段 | 含义 |
|------|------|
| `current` | 当前显示 dialog |
| `queue` | 等待显示的 dialog |
| `sourceEvent` | permission 或 interaction event |

Dialog response 不直接修改 backend 状态，只调用 SDK `respondPermission()` 或 `respondInteraction()`。

---

## 四、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 更新者 |
|------|--------|--------|
| Snapshot projection | SDK snapshot | TUI event reducer |
| Command catalog cache | backend catalog RPC | TUI catalog loader |
| Prompt input | 用户 | TUI |
| Dialog queue | SDK events | TUI DialogManager |
| Backend state | backend | 不由 TUI 修改 |

---

## 五、与其他模块的概念边界

| 概念 | UI 视角 | Backend/SDK 视角 |
|------|---------|------------------|
| command | 可输入、可补全、可提交 | catalog item + execution |
| interaction | dialog/picker | semantic request |
| runtime | status bar view model | backend runtime state |
| message | renderable item | SDK message DTO |

---

## 六、文档自检

- [x] 数据模型只描述 UI 本地状态。
- [x] 后端状态只通过 SDK 投影。
- [x] Dialog 与 backend interaction 解耦。
