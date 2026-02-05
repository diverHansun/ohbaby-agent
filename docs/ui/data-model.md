# ui 模块 data-model.md

本文档定义 `ui` 模块的核心概念与数据模型。重点是统一 UI 层的"认知模型"，而非冻结实现细节。

---

## 术语说明

| 英文术语 | 中文翻译 | 说明 |
|----------|----------|------|
| Dialog | 弹窗 | 模态弹出窗口（如权限确认、模型选择等），非用户输入对话 |
| Prompt | 输入框 | 用户输入对话/命令的区域 |
| Confirmation | 确认框 | 需要用户确认的弹窗（如 PermissionDialog） |
| Selector | 选择框 | 供用户选择的弹窗（如 ModelDialog、SessionDialog） |

---

## 一、Core Concepts（核心概念）

### 概念 1: Layout（布局）

**定义**：Layout 定义屏幕的区域划分，决定"在哪里显示"。

**特点**：
- 与具体内容（View）分离
- 固定区域：Prompt、StatusBar
- 可变区域：MainContent（由 View 填充）

### 概念 2: View（视图）

**定义**：View 是 UI 层的页面级单元，代表用户在终端中看到的一个完整界面。

**分类**：
- `HomeView`：首页视图，显示欢迎信息和初始输入框
- `ChatView`：对话视图，显示消息列表和输入框
- `HelpView`：帮助视图，显示快捷键和命令列表

**特点**：
- 同一时刻只显示一个视图
- 视图之间可以切换
- 每个视图填充 Layout 的 MainContent 区域

### 概念 3: Dialog（弹窗）

**定义**：Dialog 是模态弹出窗口，覆盖在当前视图上方，需要用户响应后才能关闭。

**分类**：
- `PermissionDialog`：权限确认弹窗（高优先级）
- `ModelDialog`：模型选择弹窗
- `SessionDialog`：会话选择弹窗
- `ConfirmDialog`：通用确认弹窗

**特点**：
- 采用**队列模式**管理，一次只显示一个
- 用户响应后关闭当前，显示下一个
- 高优先级弹窗可插队（但不打断当前显示）

### 概念 4: MessageDisplay（消息显示）

**定义**：MessageDisplay 是对 `message` 模块中 Message 和 Part 的 UI 表示，用于在对话视图中渲染。

**特点**：
- 采用**类型路由模式**，每种消息类型独立组件
- 引用 `message` 模块的数据类型
- 添加 UI 相关的状态（如 ReasoningPart 的展开/折叠状态）
- 使用**虚拟化列表**渲染，只渲染可见区域

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| ViewState | Value Object | 无身份，描述当前视图状态 |
| DialogState | Value Object | 无身份，描述弹窗队列状态 |
| DisplayState | Value Object | 无身份，描述显示相关状态 |
| PromptState | Value Object | 无身份，描述输入框状态 |
| VirtualizedState | Value Object | 无身份，描述虚拟化列表状态 |
| LoadingState | Value Object | 无身份，描述加载状态 |

---

## 三、类型定义

### 3.1 视图相关类型

```typescript
/**
 * 视图类型枚举
 */
type ViewType = 'home' | 'chat' | 'help'

/**
 * 视图状态
 */
interface ViewState {
  current: ViewType           // 当前视图
  previous?: ViewType         // 上一个视图（用于返回）
}
```

### 3.2 弹窗相关类型（队列模式）

```typescript
/**
 * 弹窗类型枚举
 */
type DialogType =
  | 'permission'              // 权限确认
  | 'model'                   // 模型选择
  | 'session'                 // 会话选择
  | 'confirm'                 // 通用确认

/**
 * 弹窗优先级
 */
type DialogPriority = 'high' | 'normal' | 'low'

/**
 * 弹窗请求
 */
interface DialogRequest {
  id: string                  // 唯一 ID
  type: DialogType            // 弹窗类型
  data: DialogData            // 弹窗数据
  priority: DialogPriority    // 优先级
  onRespond?: (result: unknown) => void  // 响应回调
  onCancel?: () => void       // 取消回调
}

/**
 * 弹窗队列状态
 */
interface DialogState {
  queue: DialogRequest[]      // 等待队列
  current: DialogRequest | null  // 当前显示的弹窗
}

/**
 * 权限弹窗数据
 */
interface PermissionDialogData {
  type: 'permission'
  permissionId: string        // 权限请求 ID
  sessionId: string           // 会话 ID
  title: string               // 显示标题
  description: string         // 详细描述
  toolName: string            // 工具名称
  metadata?: Record<string, unknown>
}

/**
 * 模型弹窗数据
 */
interface ModelDialogData {
  type: 'model'
  models: ModelInfo[]         // 可选模型列表
  currentModel: string        // 当前模型
}

/**
 * 会话弹窗数据
 */
interface SessionDialogData {
  type: 'session'
  sessions: SessionInfo[]     // 可选会话列表
  currentSessionId: string    // 当前会话 ID
}

/**
 * 确认弹窗数据
 */
interface ConfirmDialogData {
  type: 'confirm'
  title: string               // 标题
  message: string             // 消息内容
  confirmText?: string        // 确认按钮文本
  cancelText?: string         // 取消按钮文本
}

/**
 * 弹窗数据联合类型
 */
type DialogData =
  | PermissionDialogData
  | ModelDialogData
  | SessionDialogData
  | ConfirmDialogData
```

### 3.3 输入相关类型

```typescript
/**
 * 输入框状态
 */
interface PromptState {
  value: string               // 当前输入内容
  cursorPosition: number      // 光标位置
  historyIndex: number        // 历史记录索引（-1 表示当前输入）
  isMultiline: boolean        // 是否多行模式
}

/**
 * 输入历史项
 */
interface HistoryItem {
  text: string                // 输入内容
  timestamp: number           // 时间戳
}

/**
 * 自动补全状态
 */
interface CompletionState {
  suggestions: string[]       // 补全建议列表
  selectedIndex: number       // 当前选中索引
  prefix: string              // 输入前缀
  visible: boolean            // 是否显示补全
}

/**
 * 自动补全建议（Inline 模式）
 */
interface InlineCompletion {
  text: string                // 补全文本
  displayText: string         // 显示文本（灰色）
}
```

### 3.4 虚拟化相关类型

```typescript
/**
 * 虚拟化列表状态
 */
interface VirtualizedState {
  scrollTop: number                    // 滚动位置
  visibleStartIndex: number            // 可见区域起始索引
  visibleEndIndex: number              // 可见区域结束索引
  totalHeight: number                  // 总高度估算
  itemHeights: Map<string, number>     // 已渲染项的实际高度
  overscan: number                     // 缓冲区大小（预渲染上下几项）
}

/**
 * 滚动行为配置
 */
interface ScrollBehavior {
  autoScrollEnabled: boolean           // 是否启用自动滚动
  userScrolled: boolean                // 用户是否手动滚动过
  scrollThreshold: number              // 距底部多少像素认为在底部
  smoothScroll: boolean                // 是否平滑滚动
}

/**
 * 虚拟化列表 Props
 */
interface VirtualizedListProps<T> {
  items: T[]                           // 数据项
  renderItem: (item: T, index: number) => React.ReactNode
  estimatedItemHeight: (item: T, index: number) => number  // 高度估算函数
  height: number                       // 可见区域高度
  overscan?: number                    // 缓冲区大小
}
```

### 3.5 显示状态相关类型

```typescript
/**
 * 消息显示状态
 */
interface MessageDisplayState {
  messageId: string                    // 消息 ID
  expandedReasoningParts: Set<string>  // 展开的推理 Part ID 集合
}

/**
 * 工具状态颜色映射
 */
type ToolStatusColor = {
  pending: string             // 黄色
  running: string             // 蓝色
  completed: string           // 绿色
  error: string               // 红色
  aborted: string             // 灰色
}

/**
 * 加载状态（增强版，参考 gemini-cli）
 */
interface LoadingState {
  isLoading: boolean                   // 是否加载中
  phase: 'idle' | 'thinking' | 'executing' | 'streaming'  // 加载阶段
  message?: string                     // 加载提示文本
  toolName?: string                    // 当 phase = 'executing' 时显示工具名
  spinnerType: 'dots' | 'line'         // Spinner 类型
}

/**
 * 加载状态显示
 * - thinking: "✦ Thinking..."
 * - executing: "⠋ Executing tool: {toolName}"
 * - streaming: 无提示，直接显示流式内容
 */
```

### 3.6 状态栏相关类型

```typescript
/**
 * 状态栏显示数据
 */
interface StatusBarData {
  workingDirectory: string    // 工作目录
  modelName: string           // 模型名称
  mode: 'ask' | 'plan' | 'agent'  // 模式
  agentState: 'ask-before-edit' | 'edit-automatically'  // Agent 状态
  sessionName?: string        // 会话名称

  // Token 使用情况（来自 Context 模块）
  contextUsage: {
    currentTokens: number     // 当前 token 数
    contextLimit: number      // 模型 context limit
    usageRatio: number        // 使用率（0-1）
  }
}

/**
 * 状态栏 Token 显示格式
 * 示例: "1.2k (1%)" 表示使用了 1.2k tokens，占 context limit 的 1%
 */
function formatTokenDisplay(usage: StatusBarData['contextUsage']): string {
  const current = formatNumber(usage.currentTokens)  // 如 "1.2k"
  const percent = Math.round(usage.usageRatio * 100) // 如 "1"
  return `${current} (${percent}%)`
}
```

### 3.7 Context 类型定义

```typescript
/**
 * AppContext 值类型
 */
interface AppContextValue {
  view: ViewState             // 视图状态
  dialog: DialogState         // 弹窗队列状态
  loading: LoadingState       // 加载状态

  // Actions
  navigateTo: (view: ViewType) => void
  goBack: () => void

  // 弹窗队列操作
  enqueueDialog: (request: Omit<DialogRequest, 'id'>) => string  // 返回 ID
  closeCurrentDialog: () => void

  setLoading: (state: Partial<LoadingState>) => void
}

/**
 * ConfigContext 值类型
 */
interface ConfigContextValue {
  modelName: string           // 当前模型
  mode: 'ask' | 'plan' | 'agent'
  agentState: 'ask-before-edit' | 'edit-automatically'
  workingDirectory: string

  // 由外部模块更新，UI 只读
}

/**
 * SessionContext 值类型
 */
interface SessionContextValue {
  sessionId: string | null    // 当前会话 ID
  sessionName: string | null  // 会话名称
  messages: MessageWithParts[] // 消息列表（缓存）
  tokenCount: number          // Token 使用量

  // Actions
  refreshMessages: () => Promise<void>
  clearMessages: () => void
}

/**
 * KeypressContext 值类型
 */
interface KeypressContextValue {
  lastKey: KeyInfo | null     // 最后按下的键
  registerShortcut: (key: string, handler: () => void) => void
  unregisterShortcut: (key: string) => void
}

/**
 * 按键信息
 */
interface KeyInfo {
  name: string                // 键名
  ctrl: boolean               // Ctrl 修饰
  shift: boolean              // Shift 修饰
  alt: boolean                // Alt 修饰
  meta: boolean               // Meta 修饰
}
```

---

## 四、颜色定义

```typescript
/**
 * 主题颜色（单一主题）
 */
const colors = {
  // 文本颜色
  text: {
    primary: '#FFFFFF',       // 主要文本
    secondary: '#A0A0A0',     // 次要文本
    muted: '#666666',         // 弱化文本
    accent: '#00BFFF',        // 强调色
  },

  // 消息颜色
  message: {
    user: '#00FF00',          // 用户消息前缀
    assistant: '#00BFFF',     // AI 消息前缀
    system: '#FFFF00',        // 系统消息
    error: '#FF0000',         // 错误消息
  },

  // 工具状态颜色
  toolStatus: {
    pending: '#FFFF00',       // 黄色 - 等待
    running: '#00BFFF',       // 蓝色 - 执行中
    completed: '#00FF00',     // 绿色 - 完成
    error: '#FF0000',         // 红色 - 错误
    aborted: '#666666',       // 灰色 - 中断
  },

  // UI 元素颜色
  ui: {
    border: '#444444',        // 边框
    background: '#1A1A1A',    // 背景
    highlight: '#333333',     // 高亮背景
    completion: '#666666',    // 自动补全建议（灰色）
  },
}
```

---

## 五、与 message 模块的类型关系

ui 模块直接引用 `message` 模块定义的类型：

| message 模块类型 | ui 模块用途 |
|-----------------|------------|
| `Message` | 消息渲染 |
| `MessageWithParts` | 完整消息显示 |
| `Part` | Part 内容渲染 |
| `TextPart` | 文本渲染 |
| `ReasoningPart` | 推理内容渲染 |
| `ToolPart` | 工具调用渲染 |
| `ToolState` | 工具状态颜色映射 |

```typescript
// ui 模块从 message 模块导入类型
import type {
  Message,
  MessageWithParts,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState
} from '@/core/message'
```

---

## 六、Lifecycle & Ownership（生命周期与归属）

### ViewState 生命周期

```
初始化（应用启动）
    │
    ├── current = 'home'
    │
    ▼
使用中
    │
    ├── 用户输入触发切换到 'chat'
    ├── 用户请求帮助切换到 'help'
    ├── 用户返回切换到 previous
    │
    ▼
销毁（应用退出）
```

### DialogState 生命周期（队列模式）

```
空闲状态（queue = [], current = null）
    │
    ├── enqueueDialog() 被调用
    │
    ▼
有弹窗状态（current 不为空）
    │
    ├── 用户响应或取消
    │
    ▼
dequeue() → 显示下一个或回到空闲
```

### VirtualizedState 生命周期

```
初始化（MessageList 挂载）
    │
    ├── 计算初始可见区域
    │
    ▼
使用中
    │
    ├── 滚动 → 更新 visibleStartIndex/visibleEndIndex
    ├── 渲染 → 更新 itemHeights
    ├── 新消息 → 更新 totalHeight
    │
    ▼
销毁（MessageList 卸载）
```

### 数据归属

| 数据 | 创建者 | 管理者 | 说明 |
|------|--------|--------|------|
| ViewState | AppContext | AppContext | UI 层内部状态 |
| DialogState | AppContext | AppContext | UI 层内部状态，队列模式 |
| VirtualizedState | MessageList | MessageList | 组件内部状态 |
| messages | message 模块 | SessionContext | 从 message 模块获取，缓存在 Context |
| config | config 模块 | ConfigContext | 从 config 模块获取，只读 |

---

## 七、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在架构和数据流中都有使用场景
- [x] 类型定义清晰且稳定
- [x] 与 message 模块的类型关系明确
- [x] 新增：弹窗队列类型已定义
- [x] 新增：虚拟化相关类型已定义
- [x] 新增：加载状态增强已定义
- [x] 新增：自动补全类型已定义
- [x] 新增：术语说明已添加
