# Views 用例说明

## 一、用例概览

视图层的核心职责是：**在 Router 的驱动下，将正确的内容区域组件渲染到屏幕上，并对视图切换事件正确响应。**

以下是视图层的 7 个关键用例，每个用例均可追溯到 views/index.md 中的路由机制或单个 View 的职责。

| 编号 | 用例名称 | 涉及视图 | 触发来源 |
|------|---------|---------|---------|
| F1 | 应用启动渲染首屏 | HomeView | 应用初始化 |
| F2 | 首次输入跳转对话 | HomeView → ChatView | useInput hook |
| F3 | --resume 直启对话 | ChatView（跳过 Home） | App 初始化参数 |
| F4 | /help 命令打开帮助 | → HelpView | command.result.delivered |
| F5 | Esc 返回上一视图 | HelpView → previous | useKeyboard hook |
| F6 | 流式消息增量渲染 | ChatView | TuiStore part-delta emitter |
| F7 | 命令目录更新刷新帮助 | HelpView | TuiStore catalog selector |

---

## 二、主流程描述

### F1：应用启动渲染首屏

**目标**：应用启动后用户看到品牌标识和快捷操作提示，了解基本用法。

**流程**：
1. App 初始化，`AppStateContext.view.current` 默认值为 `'home'`
2. Router 读取 `view.current`，渲染 `<HomeView />`
3. HomeView 渲染 Logo + 副标题 + TipsBlock（三者均无外部数据依赖）
4. DefaultLayout 同时渲染 Prompt 输入框，等待用户操作

**输入**：无；**输出**：HomeView 可见，Prompt 就绪。

---

### F2：首次输入跳转对话

**目标**：用户在 Prompt 输入内容并提交后，从 HomeView 切换到 ChatView，对话开始。

**流程**：
1. 用户在 Prompt 输入框中键入内容，按 Enter 提交
2. `useInput` hook 检测到非命令普通 prompt，调用 `client.submitPrompt()`
3. `useInput` 同时调用 `navigateTo('chat')`，将 `view.current` 置为 `'chat'`、`view.previous` 置为 `'home'`
4. Router 切换渲染 `<ChatView />`
5. SDK 开始异步返回响应，`message.appended` 到达，ChatView 中 MessageList 显示首条消息；EmptyState 消失

**输入**：用户输入文本；**输出**：ChatView 可见，消息列表开始渲染。

**单向约束**：HomeView → ChatView 是单向切换；ChatView 不提供 goBack() 回到 HomeView 的路径（用户不应在对话进行中回到首屏）。

---

### F3：--resume 直启对话

**目标**：用户以 `--resume` 参数启动应用时，跳过首屏直接进入上次会话的 ChatView。

**流程**：
1. App 初始化检测到 `--resume` 参数（或等效的 resume session flag）
2. App 初始化逻辑直接将 `view.current` 置为 `'chat'`，跳过默认的 `'home'` 值
3. Router 渲染 `<ChatView />`
4. TuiStore 通过 `getMessages(activeSessionId)` 或 snapshot/reconcile 路径写入历史消息，MessageList 渲染历史消息列表

**输入**：启动参数 `--resume`；**输出**：ChatView 可见，历史消息已渲染。

**区别于 F2**：此路径下 HomeView 从未渲染，`view.previous` 为空。

---

### F4：/help 命令打开帮助视图

**目标**：用户输入 `/help` 并提交，TUI 打开 HelpView 展示快捷键与命令目录。

**流程**：
1. 用户在 Prompt 输入 `/help`，按 Enter 提交
2. `useInput` hook 识别为 slash 命令，调用 `executeCommand('/help')`
3. backend CommandService 处理该命令，返回 `command.result.delivered { action: { kind: 'show-help' } }`
4. TUI 的 command result handler 读取 `action.kind === 'show-help'`，调用 `navigateTo('help')`
5. `view.current` 置为 `'help'`，`view.previous` 记录当前视图（`'home'` 或 `'chat'`）
6. Router 渲染 `<HelpView />`，HelpView 从 TuiStore 读取 catalog，CommandsColumn 渲染命令列表

**输入**：`/help` 命令；**输出**：HelpView 可见，快捷键 + 命令目录已渲染。

**A' 机制约束**：backend 只返回语义化 action（`show-help`），不返回 `view: 'help'`。TUI 自主决定用 HelpView 呈现；CLI 模式可用 stdout 输出同一 action，不影响 backend。

---

### F5：Esc 返回上一视图

**目标**：用户在 HelpView 按 Esc，返回到打开帮助前的视图。

**流程**：
1. 用户在 HelpView 中按 Esc 键
2. `useKeyboard` hook 全局捕获 Esc，调用 `goBack()`
3. `goBack()` 读取 `view.previous`：
   - 若 previous 为 `'chat'`，切换回 ChatView（F4 从 ChatView 触发的场景）
   - 若 previous 为 `'home'`，切换回 HomeView（F4 从 HomeView 触发的场景）
   - 若 previous 为空（理论不应发生），不执行任何操作
4. `view.current` 更新，Router 渲染对应 View

**输入**：Esc 键；**输出**：恢复到 previous 视图。

**范围约束**：`goBack()` 不是通用历史栈回退，只记录一级 previous。HelpView 是唯一在 MVP 中使用 goBack() 的视图。

---

### F6：流式消息增量渲染

**目标**：AI 响应以流式方式到达时，ChatView 的消息列表实时显示增量内容，不卡顿。

**流程**：
1. SDK 流式输出 `message.part.delta` 事件（高频，可能每秒数十次）
2. TuiStore 内部的 part-delta emitter 直接通知订阅该消息 Part 的组件
3. 对应的 Part 组件（TextPart、ToolPart 等）局部更新，无需经过 ChatView → MessageList 的 prop 传递链
4. `message.appended`（新消息或完整消息结构到达）时，MessageList 整体重渲染，显示新消息容器
5. run 或 message 的完成状态通过既有 SDK 事件投影到 TuiStore 后，Part 组件渲染最终状态

**输入**：SDK `message.part.delta` 事件流；**输出**：Part 组件实时更新内容，ChatView 层不重渲染。

**性能关键点**：delta 更新绕过 ChatView，直达 Part 组件。ChatView 自身的重渲染频率与 `message.appended` 相同，而非 delta 频率。

---

### F7：命令目录更新自动刷新帮助

**目标**：backend CommandService 发布 catalog 更新时，HelpView 的命令列表自动反映新内容，无需用户关闭重开。

**流程**：
1. backend 发布 `command.catalog.updated` 事件（例如新增插件命令）
2. useStream 将事件投影为 `catalogInvalidation`，不直接拉取 catalog
3. useCatalog 观察到 invalidation 版本变化后调用 `client.listCommands({ surface: 'tui' })`
4. TuiStore 写入新的 `catalog` 引用，`useCommandCatalog()` selector 触发 CommandsColumn 重渲染
5. CommandsColumn 按新 catalog 重新渲染命令分组列表

**输入**：`command.catalog.updated` 事件；**输出**：HelpView 右栏命令列表更新。

**HelpView 的被动性**：HelpView 不主动拉取 catalog，不订阅事件，只读 selector 输出。数据流完全由 TuiStore 驱动。

---

## 三、责任边界

### 视图层负责

| 责任 | 说明 |
|------|------|
| 组件组合 | 决定每个 View 内部渲染哪些子组件 |
| Context 数据消费 | 通过 TuiStore selector 读取消息列表、命令目录 |
| 空态展示 | ChatView 判断 `messages.length` 决定显示 EmptyState 还是 MessageList |
| 静态内容渲染 | HomeView 的 Logo / TipsBlock；HelpView 的快捷键列表 |

### 视图层不负责

| 不负责的内容 | 由谁负责 |
|------------|---------|
| 视图切换决策 | useInput hook（F2）、App 初始化逻辑（F3）、command result handler（F4） |
| 键盘事件监听 | useKeyboard hook（全局处理 Esc、Shift+Tab 等） |
| 输入框渲染 | DefaultLayout 的 Prompt 组件 |
| 状态栏渲染 | DefaultLayout 的 StatusBar 组件 |
| 流式事件处理 | TuiStore + useStream hook |
| goBack() 逻辑 | AppActionsContext 中的 goBack() 实现 |
| catalog 数据拉取 | useCatalog hook / TuiStore |

### 边界关键点

- **Router 是纯映射**：Router 只做 `view.current → Component` 的映射，不含任何条件业务逻辑
- **View 不感知其他 View**：每个 View 组件不导入、不引用其他 View 组件
- **navigateTo / goBack 只在 View 外调用**：视图本身不直接调用路由动作；路由触发点在 hooks 和 command handler 中

---

## 四、失败点与决策点

### 4.1 view.previous 为空时 goBack() 的行为

**场景**：用户通过某种路径进入 HelpView，但 `view.previous` 为空（例如理论上的直启 help 场景）。

**预期行为**：`goBack()` 检查 `view.previous`，为空时不执行任何操作，视图保持不变。不崩溃，不回到首屏。

**决策**：MVP 不需要 fallback 到 HomeView，因为 F4 总是有 previous（从 Home 或 Chat 触发）。

---

### 4.2 /help 命令返回非 show-help action 时

**场景**：backend CommandService 的 `/help` 命令返回了不包含 `action.kind === 'show-help'` 的结果（版本不兼容、command 被覆盖等）。

**预期行为**：command result handler 不调用 `navigateTo('help')`，视图不切换。错误类响应按标准 command result 处理（在 ChatView 中展示结果文本）。

**决策**：`navigateTo('help')` 只在明确识别到 `action.kind === 'show-help'` 时触发，对未知 action 保持沉默。

---

### 4.3 --resume 时历史消息为空

**场景**：用户指定 `--resume` 但 backend 返回的 session 没有历史消息（新建会话或消息已清除）。

**预期行为**：ChatView 正常渲染，显示 EmptyState（`messages.length === 0`）。不显示错误。

**决策**：EmptyState 是合法状态，`--resume` 跳过 HomeView 不要求一定有消息。

---

### 4.4 流式更新期间视图切换（F6 + F4 并发）

**场景**：AI 正在流式输出时，用户输入 `/help` 并提交，触发 F4 切换到 HelpView。

**预期行为**：视图切换正常执行，ChatView 卸载。TuiStore 中的 part-delta emitter 仍然接收 SDK 事件并更新内部状态，但不触发已卸载组件的渲染（React 组件卸载后 useSyncExternalStore 停止订阅）。用户返回 ChatView（F5）后，看到流式更新的最终/中间状态。

**决策**：视图层不需要特殊处理此场景；TuiStore 持续接收事件，ChatView 卸载/挂载后读取最新状态。

---

## 五、文档自检

- [x] 7 个用例均可追溯到 views/index.md 的路由机制或单个 View 的职责
- [x] 每个流程说明了输入来源、视图层的步骤、外部依赖的归属
- [x] 视图层的责任边界明确：只做组件组合和数据消费，不做路由决策和事件监听
- [x] Router 的纯映射特性在责任边界中明确说明
- [x] 4 个失败/决策点覆盖了主要边界场景
- [x] A' 机制（show-help action）已在 F4 中详细说明，surface-neutral 约束已描述
- [x] F6 流式更新的高频路径绕过 ChatView 的关键点已说明
- [x] 流程描述未涉及类名、函数签名或实现代码
