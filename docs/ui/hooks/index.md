# Hooks 概述

本文档描述 ui 模块的 Hook 架构设计，定义 Hook 分层、调用规范和设计约束。

---

## 一、概述

Hook 封装交互逻辑，是组件树与 SDK/TuiStore/AppState 之间的桥梁。组件只负责渲染；Hook 负责事件订阅、命令提交、dialog 桥接和局部状态协作。

共 10 个 Hook，分为三层：

| 层级 | Hook | 特点 |
|---|---|---|
| 输入设施 | useKeypress, useMouse | 多处调用，Pub/Sub 消费者 |
| SDK/TuiStore 桥接 | useStream, useCatalog, usePermission, useInteraction | App.tsx 全局唯一，连接 SDK 与 TuiStore/dialog 队列 |
| 组件逻辑 | useInput, useKeyboard, useHistory, useAutoScroll | 单一调用位置，封装具体交互 |

---

## 二、Hook 列表

### 输入设施 Hook

| Hook | 文档 | 职责 |
|---|---|---|
| useKeypress | [use-keypress.md](./use-keypress.md) | 订阅 KeypressContext，支持条件激活 |
| useMouse | [use-mouse.md](./use-mouse.md) | 订阅 MouseContext，支持条件激活 |

### SDK/TuiStore 桥接 Hook

| Hook | 文档 | 职责 |
|---|---|---|
| useStream | [use-stream.md](./use-stream.md) | SDK 事件 → TuiStore dispatch + loading 派生 |
| useCatalog | [use-catalog.md](./use-catalog.md) | listCommands 初始化和 catalog.updated 后 refetch |
| usePermission | [use-permission.md](./use-permission.md) | permission 切片 → dialog 队列 → respondPermission |
| useInteraction | [use-interaction.md](./use-interaction.md) | interaction 切片 → dialog 队列 → respondInteraction |

### 组件逻辑 Hook

| Hook | 文档 | 职责 |
|---|---|---|
| useInput | [use-input.md](./use-input.md) | 输入处理、slash resolve、prompt 提交、补全和 hints |
| useKeyboard | [use-keyboard.md](./use-keyboard.md) | 全局键盘快捷键 |
| useHistory | [use-history.md](./use-history.md) | 输入历史导航 |
| useAutoScroll | [use-auto-scroll.md](./use-auto-scroll.md) | 消息列表自动滚动 |

---

## 三、调用位置表

每个业务 Hook 有且只有一个调用位置，避免多处调用导致状态不一致。

| Hook | 调用位置 | 读数据 | 写数据 |
|---|---|---|---|
| useStream | App.tsx | SDK 事件流 | TuiStore + AppState.loading |
| useCatalog | App.tsx | SDK `listCommands` + TuiStore.catalogInvalidation | TuiStore.catalog |
| usePermission | App.tsx | TuiStore.permissions | AppState.dialog 队列 |
| useInteraction | App.tsx | TuiStore.pending.interactions | AppState.dialog 队列 |
| useInput | Prompt 组件 | TuiStore.catalog/runtime + AppState.view | `client.submitPrompt/executeCommand` + AppActions.navigateTo |
| useKeyboard | App.tsx | AppState + TuiStore.pending/runs | `client.abortRun/executeCommand` + AppActions |
| useHistory | Prompt 组件 | 无 | 无 |
| useAutoScroll | MessageList 组件 | TuiStore.messages.length | 无 |

输入设施 Hook（useKeypress / useMouse）可在多个组件中调用，每个实例独立订阅。

---

## 四、设计原则

### 4.1 单一调用位置

每个业务 Hook 只在一个组件中调用，保证逻辑不会因多处调用而分叉。

### 4.2 Hook 之间不互相调用

Hook 之间通过 TuiStore 或 AppState/AppActions 间接通信，不直接引用其他业务 Hook。

```text
useStream ──写入──> TuiStore ──读取──> useInput / useAutoScroll
usePermission ──写入──> AppActions.enqueueDialog ──读取──> DialogManager
```

### 4.3 焦点分区

| 区域 | 负责的 Hook | 处理的按键 |
|---|---|---|
| 全局 | useKeyboard | Ctrl+C, Shift+Tab, Esc |
| Prompt 聚焦 | useInput + useHistory | Enter, 字符输入, 上/下箭头, Tab |

### 4.4 桥接与组件逻辑分离

- useStream / useCatalog / usePermission / useInteraction 是**桥接层**：只负责 SDK/TuiStore/Dialog 队列之间的转换。
- useInput / useKeyboard / useHistory / useAutoScroll 是**组件逻辑层**：服务于具体组件交互。

这避免把所有逻辑塞进一个上帝 Hook。

---

## 五、调用拓扑

```text
App.tsx
├── useStream(client)
├── useCatalog(client)
├── usePermission(client)
├── useInteraction(client)
├── useKeyboard(client)
│
├── DefaultLayout
│   ├── ChatView
│   │   └── MessageList
│   │       └── useAutoScroll()
│   │
│   ├── Prompt
│   │   ├── useInput(client)
│   │   └── useHistory()
│   │
│   └── StatusBar
│
└── DialogManager
```

---

## 六、文档自检

- [x] Hooks 已按三层分组。
- [x] 每个 Hook 的调用位置已明确。
- [x] Hook 间不互相调用的约束已说明。
- [x] 焦点分区原则已说明。
- [x] 不再引用 backend Bus、lifecycle 或 cli/commands。
