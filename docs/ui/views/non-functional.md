# Views 非功能性约束

本文档说明 views/ 模块在功能之外必须满足的工程约束。这些约束不是"未来想法"，而是**实现时需要主动保证**的边界条件。

views/ 是纯渲染层：不含业务逻辑、不处理 I/O、不依赖外部服务。它的非功能约束集中在**渲染性能边界**和**职责隔离边界**两类，而非稳定性或成本控制。

---

## 一、质量优先级

| 优先级 | 质量目标 | 说明 |
|--------|---------|------|
| P1（最高） | 渲染性能边界 | ChatView 不能成为流式更新的瓶颈；delta 高频路径不经过 ChatView |
| P2 | 职责隔离边界 | 视图层不越界承担 hook / context 的职责，腐化风险最高 |
| P3 | 实现简单性 | MVP 阶段优先可读、可维护，不追求极致优化 |

---

## 二、运行约束

### 约束 1：ChatView 不参与 part-delta 高频渲染路径

**约束内容**：`message.part.delta` 事件是流式响应期间的高频事件（可能每秒数十次）。ChatView 组件**不得**因 delta 事件触发重渲染。

**合规行为**：
- Part 组件（TextPart、ToolPart 等）通过 TuiStore 的 part-delta emitter 直接订阅更新
- ChatView 本身的重渲染仅由 `message.appended`（新消息）触发，频率极低

**违规场景示例**：
```tsx
// ❌ 违规：在 ChatView 中订阅 delta 事件，导致 ChatView 每次 delta 都重渲染
const deltas = useDeltaStream()  // 高频更新
return <MessageList deltas={deltas} />

// ✅ 合规：ChatView 只读 messages（低频），delta 由 Part 层自订阅
const { messages } = useMessages()
return messages.length === 0 ? <EmptyState /> : <MessageList />
```

**违约后果**：流式响应期间整个 ChatView 子树高频重渲染，终端会出现明显闪烁；在低性能终端（如 SSH 会话）上尤为明显。

---

### 约束 2：HomeView 不引入任何 Context 或 Provider 依赖

**约束内容**：HomeView 是纯展示组件，**不得**引入 TuiStore selector、AppStateContext、AppActionsContext 或任何其他 Provider 依赖。

**合规行为**：
- HomeView 渲染结果完全静态，任意时刻渲染输出相同
- Logo、TipsBlock 均为无状态组件

**检测方式**：test.md 的 S6 smoke test（无 Provider 渲染不崩溃）是此约束的自动化守卫。

**违约后果**：一旦 HomeView 依赖 Provider，`--resume` 启动路径或未来的 standalone 使用场景会因缺少 Provider 而崩溃；同时破坏"HomeView 零依赖"这一文档承诺。

---

### 约束 3：Router 必须是纯映射组件，不含业务逻辑

**约束内容**：Router 只执行 `view.current → <Component />` 的映射，**不得**在 Router 内部做条件判断、状态修改或副作用调用。

**合规行为**：
```tsx
// ✅ 合规：纯 switch 映射
switch (view.current) {
  case 'home': return <HomeView />
  case 'chat': return <ChatView />
  case 'help': return <HelpView />
  default:     return null
}
```

**违规场景示例**：
```tsx
// ❌ 违规：在 Router 中判断 session 状态、调用 navigateTo 或读取 SDK 数据
if (!session && view.current === 'chat') {
  navigateTo('home')  // 业务逻辑不属于 Router
}
```

**违约后果**：Router 成为隐式的"fat controller"，视图切换逻辑散落在 Router 和 hooks 两处，调试困难；新增视图时维护成本急剧上升。

---

### 约束 4：视图组件不直接监听键盘或输入事件

**约束内容**：View 组件内部**不得**调用 `useInput`（Ink 的键盘监听）、`useKeyboard`（项目封装）或任何直接监听 stdin 的 hook。

**职责归属**：
- 全局键盘事件（Esc、Shift+Tab 等）由 `useKeyboard` hook 在 App 层全局处理
- 用户文本输入由 DefaultLayout 中的 Prompt + `useInput` hook 处理
- 视图层只消费状态，不消费事件

**唯一例外**：SelectableList primitive 内部有焦点导航（方向键），但 SelectableList 属于 `components/shared/`，不属于 views/。

**违约后果**：多个视图同时监听 Esc 会导致事件处理混乱；键盘行为定义散落各视图，无法统一维护。

---

### 约束 5：HelpView 内容溢出委托给 Ink 处理

**约束内容**：HelpView 不实现自定义滚动。当终端高度不足时，内容溢出**由 Ink 的 overflow 机制截断**，HelpView 本身不介入。

**理由**：MVP 阶段命令数量可控（≤ 15 个），不值得为此引入滚动状态管理的复杂性。

**预期行为**：内容被截断（不可见），但不崩溃、不渲染乱码。用户在极小终端下会错过部分内容，这是 MVP 的已知限制。

---

## 三、可靠性与可观测性

### 失败容忍

views/ 本身无 I/O、无网络调用、无异步操作，不会产生"外部依赖失败"场景。

以下失败由视图层被动处理：

| 失败场景 | views/ 层预期行为 |
|---------|-----------------|
| TuiStore selector 返回空数组 | ChatView 显示 EmptyState；HelpView 右栏无命令，不崩溃 |
| view.current 为未知值 | Router 的 default case 返回 null，屏幕为空，不崩溃 |
| view.previous 为空时调用 goBack() | 视图不切换，不崩溃（由 AppActionsContext 保证） |

### 可观测性

views/ 是 UI 渲染层，不需要结构化日志、指标或告警。唯一有意义的可观测点是**渲染性能**，但 MVP 阶段不引入性能测量工具。

渲染异常（React 错误边界捕获的渲染报错）应在 App 层统一处理，不在单个 View 内设置 ErrorBoundary。

---

## 四、权衡与暂缓项

| 暂缓内容 | 原因 |
|---------|------|
| 终端 resize 响应 | Ink 在终端大小变化时会自动重新渲染，MVP 不需要 views/ 层主动处理 resize 事件 |
| HelpView 内容滚动 | 命令数量可控，MVP 不值为此引入滚动状态；v2 若命令超过终端高度可加 ScrollableList |
| 视图过渡动画 | 终端 TUI 无通用动画原语；MVP 视图切换为即时替换，无渐入渐出 |
| 渲染性能指标采集 | MVP 阶段无性能监控需求；若未来出现 ChatView 渲染卡顿，再引入 React Profiler 分析 |
| 多历史栈回退 | 当前只保留一级 previous；若未来需要多级历史，需要在 AppState 的 view 数据模型中引入 history 栈，不在 views/ 层处理 |

---

## 五、文档自检

- [x] 质量优先级有排序，不是平铺等价列表
- [x] 5 个运行约束均有具体模块场景，非通用口号
- [x] ChatView 高频路径约束有合规/违规对照示例
- [x] 失败容忍场景已列出，边界行为明确
- [x] 不需要可观测性的理由已说明（无 I/O，无外部依赖）
- [x] 5 个暂缓项均有明确原因，避免被误认为遗漏
