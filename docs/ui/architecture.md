# ui 模块 architecture.md

本文档描述 `ui` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的职责边界。

---

## 一、Architecture Overview（总体架构）

UI 采用 `SDK client + local store + Ink component tree` 结构：

```
UiBackendClient
   │
   ├─ getSnapshot()
   ├─ listCommands(surface)
   └─ subscribeEvents()
          │
          ▼
┌─────────────────────┐
│ TUI local store      │
│ sessions/messages    │
│ runtime/catalog      │
│ dialogs/prompt       │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ Ink component tree   │
│ Layout · Chat ·      │
│ Prompt · StatusBar · │
│ DialogManager        │
└─────────────────────┘
```

UI 对 backend 的写操作都通过 `UiBackendClient`：
- `submitPrompt()`
- `executeCommand()`
- `respondPermission()`
- `respondInteraction()`
- `abortRun()`

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Local Store

UI 将 SDK snapshot 和 events 投影为本地 store。

**理由**：
- 避免 Ink 组件直接处理 backend 协议细节。
- 方便测试 event reducer。
- 支持虚拟化和局部渲染优化。

### 2. Dialog Queue

Permission 和 interaction 使用队列管理。

**理由**：
- 避免多个 modal 同时叠加。
- 高优先级 permission 可以排在普通 interaction 前。
- Dialog response 与 SDK `respond*` 接口一一对应。

### 3. Command Runtime

Prompt 输入区包含 command runtime：
- 使用 SDK parser/resolver。
- 持有当前 command catalog。
- 提供 hints 和 Tab 补全。
- Enter 提交 exact invocation。

### 4. 未使用的模式

**不使用 backend hooks**：UI 不直接调用 backend service hook。

**不使用全局 Bus subscription**：UI 只消费 SDK events。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-cli/src/tui/
├── index.tsx                 # renderTerminalUi
├── app.tsx                   # 根组件
├── store/
│   ├── snapshot.ts
│   ├── events.ts
│   └── selectors.ts
├── command/
│   ├── runtime.ts            # parser/resolver glue
│   ├── completions.ts
│   └── hints.ts
├── dialogs/
│   ├── manager.tsx
│   ├── model-dialog.tsx
│   ├── session-dialog.tsx
│   └── confirm.tsx
├── components/
│   ├── prompt/
│   ├── dialogs/
│   ├── message/
│   ├── shared/
│   └── status-bar.tsx
└── renderers/
    ├── message.tsx
    └── command-result.tsx
```

### 对外稳定接口

- `renderTerminalUi({ client })`
- `OhbabyTerminalApp`

### 内部实现

- 组件拆分。
- store reducer 实现。
- command completion 排序。
- dialog 视觉表现。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: UI 不 import backend

**当前选择**：TUI 只依赖 SDK。

**代价**：部分 backend 类型需要通过 SDK DTO 表达。

**理由**：这是前后端分离的核心边界。

### 约束 2: Catalog 按需拉取

**当前选择**：TUI 启动时调用 `listCommands("tui")`，收到 `command.catalog.updated` 后刷新。

**代价**：需要维护 catalog loading 状态。

**理由**：catalog 低频变化，不应放进 snapshot。

### 约束 3: Hints 不是 help 命令

**当前选择**：输入 `/model` 时 UI 展示 hints；Enter 执行 `/model` 默认 interaction。

**代价**：提示体验由 TUI 实现。

**理由**：避免为每个父命令增加 help 子命令。
