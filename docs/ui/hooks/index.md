# Hooks 概述

本文档描述 ui 模块的 Hook 架构设计，定义 Hook 分层、调用规范和设计约束。

---

## 一、概述

Hook 封装交互逻辑，是 UI 组件与业务层之间的桥梁。组件只负责渲染，Hook 负责状态处理、事件订阅和业务调用。

共 8 个 Hook，分为两层：

| 层级 | Hook | 特点 |
|------|------|------|
| 底层 | useKeypress, useMouse | 多处调用，Pub/Sub 消费者 |
| 业务 | useStream, useInput, useKeyboard, useHistory, useAutoScroll, usePermission | 单一调用位置，封装具体逻辑 |

---

## 二、Hook 列表

### 底层 Hook

| Hook | 文档 | 职责 |
|------|------|------|
| useKeypress | [use-keypress.md](./use-keypress.md) | 订阅 KeypressContext，支持条件激活 |
| useMouse | [use-mouse.md](./use-mouse.md) | 订阅 MouseContext，支持条件激活 |

### 业务 Hook

| Hook | 文档 | 职责 |
|------|------|------|
| useStream | [use-stream.md](./use-stream.md) | 纯事件桥梁：Bus 事件 -> Context 状态同步 |
| useInput | [use-input.md](./use-input.md) | 输入处理和命令分流 |
| useKeyboard | [use-keyboard.md](./use-keyboard.md) | 全局键盘快捷键 |
| useHistory | [use-history.md](./use-history.md) | 输入历史导航 |
| useAutoScroll | [use-auto-scroll.md](./use-auto-scroll.md) | 消息列表自动滚动 |
| usePermission | [use-permission.md](./use-permission.md) | 权限弹窗状态管理 |

---

## 三、调用位置表

每个业务 Hook 有且只有一个调用位置，避免多处调用导致状态不一致。

| Hook | 调用位置 | 读 Context | 写 Context |
|------|----------|-----------|-----------|
| useStream | App.tsx（全局唯一） | SessionCtx | SessionCtx, AppStateCtx |
| useInput | Prompt 组件 | AppStateCtx, ConfigCtx | AppActionsCtx |
| useKeyboard | App.tsx（全局唯一） | AppStateCtx | AppActionsCtx |
| useHistory | Prompt 组件 | 无 | 无 |
| useAutoScroll | MessageList 组件 | SessionCtx (messageVersion) | 无 |
| usePermission | DialogManager 组件 | 无 | AppActionsCtx (弹窗入队) |

底层 Hook（useKeypress / useMouse）可在多个组件中调用，每个实例独立订阅。

---

## 四、设计原则

### 4.1 单一调用位置

每个业务 Hook 只在一个组件中调用。这保证：
- 状态逻辑不会因多处调用而分叉
- 调试时可以快速定位逻辑所在
- 测试时只需关注一个使用上下文

### 4.2 Hook 之间不互相调用

Hook 之间通过 Context 间接通信，不直接引用或调用其他业务 Hook。

```
useStream ──写入──> SessionContext ──读取──> useAutoScroll
usePermission ──写入──> AppActionsCtx ──读取──> DialogManager
```

这避免了 Hook 嵌套调用带来的复杂依赖关系。gemini-cli 的 useGeminiStream 内部调用 useReactToolScheduler 等多个 Hook，导致 500+ 行的上帝 Hook，是反面教材。

### 4.3 焦点分区

键盘按键的处理按焦点区域划分：

| 区域 | 负责的 Hook | 处理的按键 | 激活条件 |
|------|-----------|-----------|---------|
| 全局 | useKeyboard | Ctrl+C, Shift+Tab, Esc | 始终激活 |
| Prompt 聚焦 | useInput + useHistory | Enter, 字符输入, 上/下箭头, Tab | Prompt 处于焦点且无弹窗 |

useKeyboard 处理全局快捷键（不论焦点在哪），useInput / useHistory 处理 Prompt 内按键（仅 Prompt 聚焦时）。两者通过 useKeypress 的 `isActive` 参数天然隔离，不会抢占同一按键。

### 4.4 纯副作用 Hook

useStream 和 useKeyboard 是纯副作用 Hook（无返回值）。它们在 App.tsx 中调用一次，订阅事件并更新 Context。不返回任何值，组件不依赖它们的输出。

---

## 五、Hook 调用拓扑

```
App.tsx
├── useStream()              // 全局唯一，订阅 Bus 事件
├── useKeyboard()            // 全局唯一，处理全局快捷键
│
├── DefaultLayout
│   ├── ChatView
│   │   └── MessageList
│   │       └── useAutoScroll()     // 消息列表自动滚动
│   │
│   ├── Prompt
│   │   ├── useInput()              // 输入处理
│   │   └── useHistory()            // 历史导航
│   │
│   └── StatusBar                   // 无 Hook，纯渲染
│
└── DialogManager
    └── usePermission()             // 权限事件订阅
```

---

## 六、与 Context 的协作关系

```
                    Bus 事件
                       |
                       v
                  useStream (App.tsx)
                  /          \
                 v            v
        SessionContext    AppStateContext
          (消息缓存)        (加载状态)
            |                  |
            v                  v
       MessageList          Spinner
       useAutoScroll         Router


  KeypressContext ──> useKeypress ──> useKeyboard (App.tsx)
                                 ──> useInput (Prompt)
                                 ──> useHistory (Prompt)

  MouseContext ──> useMouse ──> ScrollableList
                           ──> Dialog
                           ──> Prompt
```

---

## 七、文档自检

- [x] Hook 分层（底层 / 业务）已说明
- [x] 每个 Hook 的调用位置已明确
- [x] Hook 间不互相调用的约束已说明
- [x] 焦点分区原则已说明
- [x] 与 Context 的读写关系已列表
- [x] 调用拓扑图已提供
