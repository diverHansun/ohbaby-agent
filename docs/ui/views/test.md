# Views 测试说明

本文档说明如何验证 views/ 模块的正确性。

views/ 的核心职责是：Router 对 view state 的正确映射，以及各 View 对 TuiStore selector 数据的正确渲染。

---

## 一、测试范围

### 覆盖

| 职责 | 测试类型 |
|------|---------|
| Router：view.current → View 组件映射 | 单元（纯逻辑） |
| navigateTo / goBack 的状态推进行为 | 单元（纯逻辑） |
| ChatView：messages 空态 vs 有消息态渲染 | 渲染（ink-testing-library） |
| HelpView：从 catalog 渲染命令分组；catalog 更新后重渲染 | 渲染（ink-testing-library） |
| HomeView：无 Provider 条件下可渲染（smoke test） | 渲染（ink-testing-library） |

### 不覆盖

| 内容 | 原因 |
|------|------|
| AppActionsContext 内部 reducer 实现细节 | 属于 contexts/ 测试范围 |
| TuiStore 内部状态机 | 属于 contexts/ 测试范围 |
| useInput / useKeyboard 事件处理逻辑 | 属于 hooks/ 测试范围 |
| /help 命令返回 show-help action 的 backend 行为 | 属于 backend commands 测试范围 |
| 流式 part-delta 渲染效果 | 属于 components/message 测试范围 |
| TUI 文字排版的完整快照 | 排版细节易变，快照测试维护成本高，不采用 |

---

## 二、关键场景（Critical Scenarios）

### P0：必须自动化覆盖

---

**S1：Router 三路映射**

视图层的入口行为，映射错误直接导致整个视图层失效。

| 输入（view.current） | 预期渲染 |
|---------------------|---------|
| `'home'` | `<HomeView />` 被挂载 |
| `'chat'` | `<ChatView />` 被挂载 |
| `'help'` | `<HelpView />` 被挂载 |

三个分支均须覆盖；不接受"其中一个 case 拼写错误但另外两个通过"的情况。

---

**S2：ChatView 空态与消息态的切换**

ChatView 的核心渲染分支。空态是合法状态（`--resume` 空会话、刚导航进来），必须有清晰展示而非空白。

- 当 `messages` 为空数组时：EmptyState 可见
- 当 `messages` 包含至少一条消息时：EmptyState 不可见，MessageList 挂载

---

**S3：HelpView 命令目录渲染**

HelpView 右栏是唯一数据驱动的列，catalog 为空或格式不正确时不应崩溃。

- 给定一个含两个 category（如 `model`、`session`）的 mock catalog，两个 category 标题均出现在渲染输出中
- catalog 更新后，渲染输出反映新数据（selector 重新订阅机制的集成验证）

---

**S4：goBack 的边界行为**

goBack 是唯一的逆向路由动作，previous 为空时行为必须安全。

- `view.previous = 'chat'`，调用 `goBack()` 后 `view.current === 'chat'`
- `view.previous = undefined`（或空），调用 `goBack()` 后 `view.current` 不变，不崩溃、不跳转到意外视图

---

### P1：覆盖，但可更轻量

---

**S5：navigateTo 状态推进（集成验证）**

navigateTo 的内部 reducer 属于 AppActionsContext，但 views/ 的集成测试需要证明 Router 能响应其结果。

- 初始 `view.current = 'home'`，调用 `navigateTo('chat')`
- 断言：`view.current === 'chat'`，`view.previous === 'home'`
- 断言：Router 重渲染为 ChatView

测试边界说明：只验证 Router 对状态变化的响应，不测试 navigateTo reducer 的内部实现（那是 AppState 的职责）。

---

**S6：HomeView smoke test（无 Provider 渲染）**

HomeView 声称零 Context 依赖，这个边界需要测试保护。若 HomeView 意外引入了 Provider 依赖，此测试会失败。

- 在无任何 Context Provider 的条件下 `render(<HomeView />)`
- 断言：不抛出错误，渲染不崩溃

不需要断言具体文本内容，smoke test 只验证"能渲染"。

---

## 三、集成点测试

### 与 AppStateContext / AppActionsContext

views/ 的路由行为依赖 AppStateContext 提供的 `view.current` 和 AppActionsContext 提供的 `navigateTo` / `goBack`。

- 测试时使用 mock context（提供 `view.current` 受控值），验证 Router 对 state 的响应
- navigateTo / goBack 的 reducer 逻辑（S5）在 views/ 层作为集成验证，以保证 Router 响应链完整；reducer 细节测试属于 contexts/ 职责

### 与 TuiStore

ChatView 依赖 `useMessages()` selector，HelpView 依赖 `useCommandCatalog()` selector。

- 测试时 mock TuiStore selector 返回值，不启动真实 TuiStore 状态机
- catalog 更新的 S3 场景：通过 mock store 触发 selector 更新，验证 CommandsColumn 重渲染，不测试 TuiStore 内部事件处理

### 外部依赖失败时的预期

| 外部依赖 | 失败场景 | views/ 层预期行为 |
|---------|---------|-----------------|
| useMessages() 返回空数组 | 正常（ChatView 显示 EmptyState） |
| useCommandCatalog() 返回空数组 | HelpView 右栏无分组，不崩溃 |
| view.current 为未知值 | Router 渲染 null 或 fallback，不崩溃 |

---

## 四、验证策略

### 测试栈

**vitest + ink-testing-library**

- vitest：项目测试 runner，与 styles/ 等其他模块保持一致
- ink-testing-library：专为 Ink React 组件设计，`render()` 返回 `lastFrame()` 文本输出，可断言关键文本是否出现

### 分层策略

| 测试类型 | 适用场景 | 特点 |
|---------|---------|------|
| 纯逻辑单元测试 | Router 映射（S1）、goBack 状态推进（S4）、navigateTo 集成（S5） | 无渲染，速度快，维护成本低 |
| ink-testing-library 渲染测试 | ChatView 空态切换（S2）、HelpView catalog 渲染（S3）、HomeView smoke（S6） | 验证渲染输出，mock TuiStore selector |

**不采用**：完整 TUI 快照测试（snapshot testing）。Ink 组件的文本布局依赖终端宽度，快照极易因排版变动失效，维护成本远超价值。

### mock 原则

- **mock TuiStore selector 返回值**，不 mock TuiStore 内部实现
- **mock AppStateContext**（提供受控 view state），不 mock AppActionsContext 的 reducer 逻辑（S5 需要 reducer 真实执行）
- 无需 mock SDK client、backend 或任何 I/O

### 测试文件位置

```
packages/ohbaby-cli/src/tui/views/
├── __tests__/
│   ├── router.test.tsx          # S1 Router 映射 + S5 navigateTo 集成
│   ├── chat-view.test.tsx       # S2 EmptyState 切换
│   ├── help-view.test.tsx       # S3 catalog 渲染 + 更新
│   └── home-view.test.tsx       # S6 smoke test
```

goBack 边界行为（S4）归入 `router.test.tsx`，因为 goBack 的效果通过 Router 响应来验证。

---

## 五、不需要测试的内容

| 内容 | 原因 |
|------|------|
| HomeView 的 Logo 文字内容 | 营销文案，不是行为约束 |
| HelpView 快捷键文字 | 静态硬编码，无逻辑；修改时人工可见 |
| ChatView 中 MessageList 渲染具体消息 | 属于 components/message 测试范围 |
| 流式 delta 更新的渲染效果 | 属于 TuiStore + Part 组件测试范围 |
| F4 /help → show-help action 的触发 | 属于 command result handler 测试范围 |
| 任何 CSS/颜色/布局细节 | 属于 styles/ 测试范围 |

---

## 六、文档自检

- [x] 测试策略明确：混合模式（纯逻辑单元 + ink 渲染），不做快照测试
- [x] P0 / P1 分层，关键场景（S1-S4）有明确的预期结果
- [x] 集成点说明：与 AppStateContext / TuiStore 的 mock 策略
- [x] 边界归属清晰：reducer 细节测 contexts/，views/ 只做集成验证
- [x] 外部依赖失败时的 views/ 层预期行为已列出
- [x] 测试文件位置已指定
- [x] 不测什么已明确列出
