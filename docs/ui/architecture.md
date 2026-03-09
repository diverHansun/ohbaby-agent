# ui 模块 architecture.md

本文档描述 `ui` 模块的内部结构与设计模式，服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

ui 模块采用 **React + Ink** 构建终端用户界面，内部分为以下子组件：

### 1.1 子组件职责划分

| 子组件 | 职责 |
|--------|------|
| **app** | TUI 应用入口，组装 Context Provider 和根视图 |
| **layouts** | 布局层，定义屏幕区域划分（在哪里显示） |
| **views** | 视图层，管理不同页面的具体内容（显示什么） |
| **components** | UI 组件库，提供可复用的渲染单元 |
| **context** | 状态管理，通过 React Context 提供全局状态 |
| **hooks** | 交互逻辑封装，连接 UI 与业务层 |
| **styles** | 样式定义，统一颜色和视觉常量 |

### 1.2 子组件依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                        app.tsx                              │
│                     (应用入口)                               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Context Providers                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  Config  │ │ Keypress │ │  Mouse   │ │ AppState │       │
│  │ Context  │ │ Context  │ │ Context  │ │ Context  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐                                  │
│  │ Session  │ │AppActions│                                  │
│  │ Context  │ │ Context  │                                  │
│  └──────────┘ └──────────┘                                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        Layout                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MainContent (可变)  │  Prompt (固定)  │ StatusBar  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        Views                                │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │  HomeView │ │  ChatView │ │  HelpView │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Components                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ MessageList │ │   Prompt    │ │  Dialogs    │           │
│  │ (虚拟化)    │ │ (自动补全)   │ │  (队列)     │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ Messages    │ │  StatusBar  │ │   Shared    │           │
│  │ (类型路由)   │ │             │ │ (基础组件)   │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        Hooks                                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │useStream│ │useKey   │ │useKey   │ │useMouse │           │
│  │         │ │  press  │ │  board  │ │         │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │useInput │ │useHis   │ │useAuto  │ │usePerm  │           │
│  │         │ │  tory   │ │  Scroll │ │ ission  │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   External Modules                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │   Bus   │ │lifecycle│ │cli/cmds │ │permis-  │           │
│  │         │ │         │ │         │ │  sion   │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 使用的设计模式

#### Pattern 1: Provider Pattern（Context Provider 模式）

**使用场景**：全局状态管理

**理由**：
- 避免 props drilling，深层组件可直接访问状态
- 状态变更自动触发相关组件重渲染
- 与 React 生态天然契合

**应用**：
- `AppStateContext`：视图状态、弹窗队列、加载状态（只读）
- `AppActionsContext`：视图跳转、弹窗入队、加载控制（动作）
- `ConfigContext`：模型、模式等配置（只读）
- `SessionContext`：当前会话、消息缓存（含 messageVersion）
- `KeypressContext`：键盘输入 Pub/Sub 订阅
- `MouseContext`：鼠标事件 Pub/Sub 订阅

#### Pattern 2: Custom Hook Pattern（自定义 Hook 模式）

**使用场景**：封装交互逻辑

**理由**：
- 将状态逻辑与 UI 渲染分离
- 逻辑可复用、可测试
- 保持组件简洁

**应用**：
- `useStream`：订阅 Bus 事件，处理流式响应，驱动 SessionContext 更新
- `useKeypress`：封装 KeypressContext 订阅，供组件级键盘监听使用
- `useMouse`：封装 MouseContext 订阅，供组件级鼠标监听使用
- `useInput`：输入处理和命令分流（slash 命令 vs 普通对话）
- `useKeyboard`：全局键盘快捷键（Ctrl+C 双击中断、Shift+Tab 切换模式等）
- `useHistory`：输入历史导航（上/下箭头键）
- `useAutoScroll`：自动滚动控制（新消息到达时滚动到底部）
- `usePermission`：权限请求事件 → 弹窗入队

#### Pattern 3: Compound Component Pattern（复合组件模式）

**使用场景**：弹窗组件

**理由**：
- 弹窗有共同的基础结构（标题、内容、按钮）
- 但具体内容和行为不同
- 通过组合实现复用

**应用**：
- `Dialog`（基础组件）+ `PermissionDialog`、`ModelDialog` 等

#### Pattern 4: Type Router Pattern（类型路由模式）

**使用场景**：消息组件

**理由**：
- 不同消息类型（User/Assistant/System）有不同的渲染逻辑
- 每种类型独立组件，便于维护和测试
- 新增消息类型时只需添加新组件

**应用**：

```
MessageList
├── HistoryItemDisplay (路由器)
│   ├── UserMessage
│   ├── AssistantMessage
│   └── SystemMessage (内部按 kind 分发)
│       ├── kind: 'abort'
│       ├── kind: 'error'
│       └── kind: 'info'
```

**参考**：gemini-cli 的 HistoryItemDisplay 设计

#### Pattern 5: Queue Pattern（队列模式）

**使用场景**：弹窗管理

**理由**：
- 多个弹窗请求可能同时到达（如权限确认）
- 叠加显示会导致 UI 错位
- 队列模式保证每次只显示一个弹窗，用户响应后显示下一个

**应用**：

```typescript
DialogManager
├── queue: DialogRequest[]     // 等待队列
├── current: DialogRequest     // 当前显示
├── enqueue()                  // 加入队列
├── dequeue()                  // 取出下一个
└── 高优先级可插队（但不打断当前）
```

#### Pattern 6: Virtualization Pattern（虚拟化模式）

**使用场景**：消息列表

**理由**：
- 长对话可能有数百条消息
- 全部渲染会导致性能问题
- 虚拟化只渲染可见区域，保持恒定性能

**应用**：

```
VirtualizedList (底层)
├── 计算可见区域
├── 只渲染可见项
├── 动态高度估算 (estimatedItemHeight)
└── 滚动位置管理

ScrollableList (上层)
├── 基于 VirtualizedList
├── 滚动条 UI
├── 平滑滚动动画
└── 自动滚动到底部
```

**参考**：gemini-cli 的 VirtualizedList 设计

### 2.2 未使用的设计模式

#### 未使用 Observer Pattern

**理由**：已通过 Bus 模块实现事件订阅，ui 模块只需调用 `Bus.subscribe()`，无需自行实现观察者模式。

#### 未使用 State Machine Pattern

**理由**：视图切换逻辑简单（三个视图），使用简单的状态变量即可，无需引入状态机复杂度。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 目录结构

```
src/ui/
├── index.ts                    # 模块入口，导出 render 函数
├── app.tsx                     # TUI 应用主组件
│
├── layouts/                    # 布局层（新增）
│   ├── index.ts               # 布局导出
│   └── DefaultLayout.tsx      # 默认布局
│
├── views/                      # 视图层
│   ├── index.ts               # 视图导出
│   ├── Router.tsx             # 视图路由（读 AppStateContext.view.current）
│   ├── HomeView.tsx           # 首页视图（Logo + 引导提示）
│   ├── ChatView.tsx           # 对话视图（MessageList）
│   └── HelpView.tsx           # 帮助视图（双栏：快捷键 + 命令）
│
├── components/                 # UI 组件
│   ├── index.ts               # 组件导出
│   │
│   ├── message/               # 消息组件（类型路由模式）
│   │   ├── index.ts
│   │   ├── MessageList.tsx    # 消息列表（虚拟化容器）
│   │   ├── HistoryItemDisplay.tsx  # 类型路由器
│   │   ├── UserMessage.tsx    # 用户消息
│   │   ├── AssistantMessage.tsx    # AI 消息
│   │   └── SystemMessage.tsx  # 系统消息
│   │
│   ├── parts/                 # Part 渲染子组件
│   │   ├── index.ts
│   │   ├── TextPart.tsx       # 文本内容渲染
│   │   ├── ReasoningPart.tsx  # 推理内容渲染（可折叠）
│   │   ├── ToolPart.tsx       # 工具调用渲染
│   │   └── FilePart.tsx       # 文件附件渲染
│   │
│   ├── prompt/                # 输入框组件
│   │   ├── index.ts
│   │   ├── Prompt.tsx         # 主输入框
│   │   └── Completion.tsx     # 自动补全建议（Inline）
│   │
│   ├── dialogs/               # 弹窗组件（队列管理）
│   │   ├── index.ts
│   │   ├── DialogManager.tsx  # 弹窗队列管理器
│   │   ├── Dialog.tsx         # 基础弹窗
│   │   ├── PermissionDialog.tsx   # 权限确认弹窗
│   │   ├── ModelDialog.tsx    # 模型选择弹窗
│   │   ├── SessionDialog.tsx  # 会话选择弹窗
│   │   └── ConfirmDialog.tsx  # 通用确认弹窗
│   │
│   ├── shared/                # 通用基础组件
│   │   ├── index.ts
│   │   ├── VirtualizedList.tsx    # 虚拟化列表
│   │   ├── ScrollableList.tsx     # 可滚动列表
│   │   ├── Collapsible.tsx    # 可折叠容器
│   │   ├── MaxSizedBox.tsx    # 高度限制容器
│   │   ├── Spinner.tsx        # 加载动画
│   │   ├── LoadingIndicator.tsx   # 加载指示器（剑图标 + Spinner）
│   │   ├── TipsBlock.tsx      # 首页引导提示
│   │   ├── Typewriter.tsx     # 打字机效果
│   │   └── DiffRenderer.tsx   # Diff 渲染器
│   │
│   ├── StatusBar.tsx          # 状态栏组件
│   └── Logo.tsx               # Logo 组件
│
├── context/                    # React Context
│   ├── index.ts               # Context 导出
│   ├── AppStateContext.tsx    # 应用只读状态 Context（view/dialog/loading）
│   ├── AppActionsContext.tsx  # 应用动作 Context（navigateTo/enqueueDialog 等）
│   ├── ConfigContext.tsx      # 配置 Context
│   ├── SessionContext.tsx     # 会话 Context（消息缓存 + messageVersion）
│   ├── KeypressContext.tsx    # 键盘输入 Context（Pub/Sub）
│   └── MouseContext.tsx       # 鼠标事件 Context（Pub/Sub）
│
├── hooks/                      # 自定义 Hooks
│   ├── index.ts               # Hooks 导出
│   ├── useStream.ts           # 流式响应订阅（App.tsx，唯一）
│   ├── useKeypress.ts         # 键盘事件订阅封装
│   ├── useMouse.ts            # 鼠标事件订阅封装
│   ├── useInput.ts            # 输入处理和命令分流（Prompt，唯一）
│   ├── useKeyboard.ts         # 全局键盘快捷键（App.tsx，唯一）
│   ├── useHistory.ts          # 输入历史导航（Prompt，唯一）
│   ├── useAutoScroll.ts       # 自动滚动控制（MessageList，唯一）
│   └── usePermission.ts       # 权限弹窗入队（DialogManager，唯一）
│
└── styles/                     # 样式定义
    ├── index.ts               # 样式导出
    ├── colors.ts              # 颜色常量
    ├── tokens.ts              # 设计 tokens
    └── theme-manager.ts       # 主题管理器（预留扩展）
```

### 3.2 各目录职责定位

| 目录 | 职责 | 稳定性 |
|------|------|--------|
| `layouts/` | 屏幕区域划分 | 对外稳定 |
| `views/` | 页面级组件，具体内容 | 对外稳定 |
| `components/message/` | 消息类型路由和渲染 | 对外稳定 |
| `components/parts/` | Part 类型渲染 | 内部实现 |
| `components/prompt/` | 输入框和补全 | 对外稳定 |
| `components/dialogs/` | 弹窗组件和队列管理 | 对外稳定 |
| `components/shared/` | 通用基础组件 | 内部实现 |
| `context/` | 全局状态管理 | 对外稳定 |
| `hooks/` | 交互逻辑封装 | 对外稳定 |
| `styles/` | 视觉常量定义 | 内部实现 |

### 3.3 关键文件说明

#### app.tsx

应用入口，组装 Context Provider 和 Layout：

```tsx
// 职责：组装 Provider 树和布局
export function App() {
  return (
    <ConfigProvider>          {/* 最外层：无依赖，低频变化 */}
      <KeypressProvider>      {/* 依赖 stdin，无 Context 依赖 */}
        <MouseProvider>       {/* 依赖 stdin，与 Keypress 同层 */}
          <AppStateProvider>  {/* 依赖 Keypress/Mouse（用于快捷键检测） */}
            <SessionProvider> {/* 依赖 AppState（需要 sessionId） */}
              <AppActionsProvider> {/* 最内层：需要读 AppState + Session */}
                <DefaultLayout>
                  <Router />        {/* 根据视图状态渲染 View */}
                </DefaultLayout>
                {/* DialogManager 在 DefaultLayout 内部渲染，位于 Prompt 上方 */}
              </AppActionsProvider>
            </SessionProvider>
          </AppStateProvider>
        </MouseProvider>
      </KeypressProvider>
    </ConfigProvider>
  );
}
```

#### layouts/DefaultLayout.tsx

默认布局，定义屏幕区域：

```tsx
// 职责：定义屏幕结构（在哪里显示）
export function DefaultLayout({ children }) {
  return (
    <Box flexDirection="column" height="100%">
      <Box flexGrow={1}>
        {children}              {/* MainContent 区域 */}
      </Box>
      <DialogManager />         {/* 弹窗队列管理（与 LoadingIndicator 互斥显示） */}
      <LoadingIndicator />      {/* 加载指示器（条件渲染） */}
      <Prompt />                {/* 固定输入框 */}
      <StatusBar />             {/* 固定状态栏 */}
    </Box>
  );
}
```

#### components/message/HistoryItemDisplay.tsx

消息类型路由器：

```tsx
// 职责：根据消息类型分发到对应组件
export function HistoryItemDisplay({ message, parts }) {
  switch (message.role) {
    case 'user':
      return <UserMessage message={message} parts={parts} />;
    case 'assistant':
      return <AssistantMessage message={message} parts={parts} />;
    case 'system':
      return <SystemMessage message={message} parts={parts} />;
    default:
      return null;
  }
}
```

#### components/dialogs/DialogManager.tsx

弹窗队列管理器：

```tsx
// 职责：管理弹窗队列，确保一次只显示一个
export function DialogManager() {
  const { queue, current, dequeue } = useDialogQueue();

  if (!current) return null;

  const handleClose = () => {
    dequeue();  // 关闭当前，显示下一个
  };

  switch (current.type) {
    case 'permission':
      return <PermissionDialog data={current.data} onClose={handleClose} />;
    case 'model':
      return <ModelDialog data={current.data} onClose={handleClose} />;
    // ...
  }
}
```

#### components/shared/VirtualizedList.tsx

虚拟化列表：

```tsx
// 职责：只渲染可见区域的列表项
export function VirtualizedList<T>({
  items,
  renderItem,
  estimatedItemHeight,
  height
}) {
  // 1. 计算可见区域的起止索引
  // 2. 只渲染可见项
  // 3. 用占位符填充不可见区域
  // 4. 滚动时更新可见区域
}
```

#### hooks/useInput.ts

输入处理 hook，支持自动补全：

```tsx
// 职责：处理用户输入，分流到不同处理路径
export function useInput() {
  const handleSubmit = async (text: string) => {
    if (text.startsWith('/')) {
      return await executeSlashCommand(text);
    } else {
      return await lifecycle.execute(text);
    }
  };

  const getCompletions = (prefix: string) => {
    // 获取命令补全建议
    return cli.commands.getCompletions(prefix);
  };

  return { handleSubmit, getCompletions };
}
```

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 约束

#### 约束 1: 依赖 Ink 框架

ui 模块完全依赖 Ink 进行终端渲染。这意味着：
- 组件必须使用 Ink 提供的原语（Box, Text 等）
- 布局受终端能力限制
- 不能使用 Web DOM API

#### 约束 2: 单一主题（MVP）

MVP 阶段不支持主题切换，但通过 ThemeManager 预留扩展接口。

#### 约束 3: 同步事件处理

假设 Bus 事件是同步发布的，UI 更新不会有明显延迟。

#### 约束 4: 虚拟化列表

消息列表必须使用虚拟化，这是性能的硬性要求。

### 4.2 权衡

#### 权衡 1: 类型路由模式 vs 单一组件

**选择**：消息组件采用类型路由模式（每种消息类型独立组件）

**代价**：文件数量增多

**收益**：
- 每种消息类型逻辑独立，便于维护
- 新增类型只需添加新组件
- 代码更模块化，易于测试

**理由**：参考 gemini-cli 的设计，类型路由模式在实践中证明更易维护

#### 权衡 2: 弹窗队列 vs 弹窗叠加

**选择**：弹窗采用队列模式，不叠加显示

**代价**：用户需要逐个处理多个弹窗

**收益**：
- 避免 UI 错位（终端环境按钮容易重叠）
- 用户体验更清晰
- 实现更简单可靠

**理由**：终端 UI 的布局能力有限，叠加显示容易出问题

#### 权衡 3: 布局与视图分离

**选择**：引入 Layout 层，与 View 分离

**代价**：增加一层抽象

**收益**：
- 屏幕结构（Layout）与具体内容（View）解耦
- 为未来不同布局（如 ScreenReaderLayout）预留空间
- 职责更清晰

**理由**：参考 gemini-cli 的 DefaultAppLayout 设计

#### 权衡 4: Context 数量与分工

**选择**：使用 6 个独立 Context 而非 1 个大 Context

**代价**：Provider 嵌套层级增加

**收益**：
- 状态更新粒度更细，避免不必要的重渲染
- 读写分离：AppStateContext（只读）+ AppActionsContext（动作），actions 引用永不变化
- 输入层与业务层解耦：KeypressContext / MouseContext 仅提供事件流

**理由**：
- Config 变化频率极低，Session 消息频繁更新，分开管理可优化性能
- State/Actions 分离参考 gemini-cli 的 UIStateContext + UIActionsContext 设计
- Keypress/Mouse 使用 Pub/Sub 订阅模式，不会因每次按键触发全局重渲染

---

## 五、文档自检

- [x] 可以清楚说出每个子组件存在的理由
- [x] 不存在无法追溯到 goals-duty.md 的结构
- [x] 不存在为了"优雅"而增加的复杂性
- [x] 文件组织反映职责划分
- [x] 设计模式的使用有明确理由
- [x] 新增：Layout 层已加入架构
- [x] 新增：类型路由模式已说明
- [x] 新增：弹窗队列模式已说明
- [x] 新增：虚拟化模式已说明
- [x] 更新：AppContext 已拆分为 AppStateContext + AppActionsContext（6 个 Context）
- [x] 更新：hooks 目录已包含全部 8 个 Hook（含 useKeypress、useMouse）
- [x] 更新：Provider 嵌套顺序已按依赖关系调整
