# ui 模块 dfd-interface.md

本文档描述 `ui` 模块的数据流与接口定义，明确模块如何与外部发生交互。

---

## 一、Context & Scope（上下文与范围）

### 1.1 模块在系统中的位置

ui 模块位于系统的**最上层**，是用户与系统交互的唯一入口：

```
┌─────────────────────────────────────────────────────────┐
│                       用户                              │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                      ui 模块                            │
│              (终端渲染、用户交互)                         │
└─────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ cli/commands│ │  lifecycle  │ │  permission │
    │ (slash命令)  │ │  (对话执行)  │ │  (权限确认)  │
    └─────────────┘ └─────────────┘ └─────────────┘
```

### 1.2 交互模块列表

| 模块 | 交互方向 | 交互内容 |
|------|----------|----------|
| Bus | 订阅 | 消息更新、权限请求、模式变更等事件 |
| cli/commands | 调用 | 执行 slash 命令 |
| lifecycle | 调用 | 执行普通对话 |
| permission | 调用 | 返回权限确认结果 |
| message | 读取 | 获取消息数据（通过 SessionContext） |
| session | 读取 | 获取会话数据（通过 SessionContext） |
| config | 读取 | 获取配置数据（通过 ConfigContext） |
| policy | 读取 | 获取模式状态 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 数据流概览图

```
┌─────────────────────────────────────────────────────────────────────┐
│                           ui 模块                                   │
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │   用户输入   │───▶│  useInput   │───▶│  命令分流                │ │
│  │  (Prompt)   │    │   (hook)    │    │  - slash → cli/commands │ │
│  └─────────────┘    └─────────────┘    │  - 普通 → lifecycle     │ │
│                                        └─────────────────────────┘ │
│                                                     │               │
│                                                     ▼               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │  消息渲染    │◀───│ useStream   │◀───│  Bus 事件订阅            │ │
│  │  (Message)  │    │   (hook)    │    │  - Message.Event.*      │ │
│  └─────────────┘    └─────────────┘    │  - Permission.Event.*   │ │
│        ▲                               │  - Policy.Event.*       │ │
│        │                               └─────────────────────────┘ │
│        │                                            ▲               │
│  ┌─────────────┐                                    │               │
│  │SessionContext│◀──────────────────────────────────┘               │
│  │  (消息缓存)  │                                                    │
│  └─────────────┘                                                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流详细描述

#### Flow 1: 用户输入处理流

```
1. 用户在 Prompt 组件输入文本
2. 按 Enter 提交
3. useInput hook 接收输入
4. 判断输入类型：
   4a. 以 "/" 开头 → 调用 cli/commands.executeSlashCommand()
   4b. 普通文本 → 调用 lifecycle.execute()
5. 等待执行结果
6. 更新 UI 状态（清空输入、显示加载等）
```

**数据转换**：
- 输入：`string`（用户输入的文本）
- 输出：`void`（触发异步操作）

#### Flow 2: 消息更新流（流式响应）

```
1. lifecycle 执行对话，llm-client 返回流式响应
2. message 模块更新 Part，发布 Bus 事件：
   - Message.Event.Updated（消息元数据更新）
   - Message.Event.PartUpdated（Part 内容更新，含 delta）
3. useStream hook 订阅事件
4. 更新 SessionContext 中的消息缓存
5. Message 组件重新渲染，显示新内容
```

**数据转换**：
- 输入：`MessageEvent.PartUpdated { part, delta? }`
- 处理：合并 delta 到现有 Part
- 输出：更新后的 `MessageWithParts[]`

#### Flow 3: 权限确认流

```
1. tool-scheduler 需要用户确认，调用 permission.ask()
2. permission 模块发布 Bus 事件：Permission.Event.Updated
3. usePermission hook 订阅事件
4. 打开 PermissionDialog 显示确认请求
5. 用户选择响应（once/always/reject/suggest）
6. 调用 permission.respond() 返回结果
7. 关闭对话框
8. permission 模块 resolve/reject 原始 Promise
```

**数据转换**：
- 输入：`PermissionInfo { id, type, name, title, ... }`
- 用户响应：`PermissionResponse { type: 'once' | 'always' | 'reject' | 'suggest', ... }`
- 输出：调用 `permission.respond(sessionId, permissionId, response)`

#### Flow 4: 模式切换流

```
1. 用户按 Shift+Tab
2. useKeyboard hook 捕获快捷键
3. 调用 commands.execute('agents.mode.cycle')
4. policy 模块更新模式，发布 Bus 事件：Policy.Event.ModeChanged
5. ConfigContext 更新模式状态
6. StatusBar 组件重新渲染，显示新模式
```

**数据转换**：
- 输入：键盘事件 `{ name: 'tab', shift: true }`
- 输出：模式更新 `mode: 'ask' | 'plan' | 'agent'`

#### Flow 5: 视图切换流

```
1. 触发视图切换（用户操作或命令）
2. AppContext.navigateTo(viewType) 被调用
3. 更新 ViewState.current
4. 保存 ViewState.previous（用于返回）
5. Router 组件根据 current 渲染对应视图
```

**数据转换**：
- 输入：`ViewType`（目标视图）
- 输出：更新 `ViewState { current, previous }`

#### Flow 6: 弹窗队列管理流

```
1. 触发打开弹窗（事件或命令）
2. DialogManager.enqueue(request) 加入队列
3. 检查当前是否有弹窗显示：
   3a. 无当前弹窗 → 立即显示新弹窗
   3b. 有当前弹窗 → 根据优先级排队
       - 高优先级（如 PermissionDialog）→ 插入队列前面
       - 普通优先级 → 追加到队列末尾
4. DialogManager 渲染 current 弹窗
5. 用户响应后调用 resolveDialog(result)
6. 关闭当前弹窗，从队列取出下一个
7. 如果队列非空，显示下一个弹窗
```

**队列管理逻辑**：
```typescript
enqueue(request):
  if request.priority === 'high':
    queue.unshift(request)  // 插入队列前面（但不打断当前显示）
  else:
    queue.push(request)     // 追加到队列末尾

  if current === null:
    current = queue.shift()  // 立即显示
```

**数据转换**：
- 输入：`DialogRequest { type, data, priority, resolve }`
- 队列状态：`DialogState { current, queue }`
- 输出：调用 `resolve(result)` 返回用户响应

#### Flow 7: StatusBar 数据流

```
1. StatusBar 组件始终显示在界面底部
2. ConfigContext 提供：modelName, mode, agentState, workingDirectory
3. SessionContext 提供：sessionName
4. Context 模块提供：contextUsage（通过 Bus 事件更新）
5. StatusBar 组件订阅 Context.Event.UsageUpdated 事件
6. 当上下文使用量变化时，更新 token 显示
7. Token 格式："1.2k (1%)" 表示当前用量和占 context limit 的百分比
```

**数据来源**：
- `ConfigContext`：`{ modelName, mode, agentState, workingDirectory }`
- `SessionContext`：`{ sessionName }`
- `Bus 事件`：`Context.Event.UsageUpdated { currentTokens, contextLimit, usageRatio }`

**显示格式**：
```
[cwd] | [model] | [mode] | [agentState] | [session] | [tokens]
例如：/project | claude-opus | agent | ask-before-edit | Session #1 | 12.5k (10%)
```

**说明**：
- StatusBar 不显示警告信息，context 模块会在 85% 阈值时自动触发压缩
- 自动压缩时 UI 显示通知（由 cli/commands 订阅 Context.Event.Compressed 处理）

#### Flow 8: Tab 自动补全流

```
1. 用户在 Prompt 输入文本
2. useCompletion hook 监听输入变化
3. 检测输入是否以 "/" 开头
   3a. 非 slash 命令 → 不显示补全
   3b. slash 命令 → 继续处理
4. 调用 cli/commands.getCompletions(input) 获取补全建议
5. 更新 CompletionState { suggestions, selectedIndex }
6. Prompt 组件渲染 inline 补全（光标后灰色文本）
7. 用户按 Tab：
   7a. 有补全建议 → 应用当前选中的补全
   7b. 无补全建议 → 忽略
8. 应用补全后清空 suggestions
```

**Inline 补全显示**：
```
用户输入: /mod
补全建议: el
显示效果: /mod|el  (el 为灰色，| 为光标位置)
```

**数据转换**：
- 输入：`string`（当前输入文本）
- 中间：`Completion[]`（补全建议列表）
- 输出：`CompletionState { suggestions, selectedIndex, visible }`

#### Flow 9: 虚拟化列表滚动流

```
1. MessageList 组件挂载
2. useVirtualizedList hook 初始化：
   - 计算可见区域高度
   - 设置初始滚动位置（底部）
3. 消息更新时：
   3a. 计算每条消息的估算高度
   3b. 确定可见范围 [startIndex, endIndex]
   3c. 只渲染可见范围内的消息
   3d. 不可见消息使用占位符
4. 用户滚动时：
   4a. 更新 scrollTop
   4b. 重新计算可见范围
   4c. 更新渲染的消息列表
5. 新消息到达时：
   5a. 检查 autoScroll 状态
   5b. 如果用户在底部 → 自动滚动到新消息
   5c. 如果用户已向上滚动 → 保持当前位置
```

**高度估算策略**：
```typescript
estimateHeight(message):
  baseHeight = 24  // 基础行高
  contentLines = estimateLines(message.content)
  toolCount = message.parts.filter(p => p.type === 'tool').length
  return baseHeight + (contentLines * 20) + (toolCount * 60)
```

**数据转换**：
- 输入：`MessageWithParts[]`（完整消息列表）
- 状态：`VirtualizedState { scrollTop, visibleRange, itemHeights }`
- 输出：`VisibleItem[]`（只包含可见范围的消息）

#### Flow 10: 消息类型路由流

```
1. MessageList 遍历消息数组
2. 对每条消息，根据 message.role 路由：
   - role: 'user' → UserMessage 组件
   - role: 'assistant' → AssistantMessage 组件
   - role: 'system' → SystemMessage 组件
3. SystemMessage 内部根据 kind 二次路由：
   - kind: 'abort' → AbortMessage
   - kind: 'error' → ErrorMessage
   - kind: 'info' → InfoMessage
4. 各组件独立渲染其 parts
```

**类型路由优势**：
- 每种消息类型独立组件，职责单一
- 便于针对特定类型添加功能
- 测试更加聚焦

---

## 三、Interface Definition（接口定义）

### 3.1 模块入口接口

```typescript
/**
 * ui 模块入口函数
 * 启动 TUI 应用
 */
function render(options: RenderOptions): void

interface RenderOptions {
  sessionId?: string          // 初始会话 ID
  prompt?: string             // 初始 prompt（命令行传入）
}
```

### 3.2 Context 接口

#### AppContext

```typescript
interface AppContextValue {
  // 状态
  view: ViewState
  dialog: DialogState        // 弹窗队列状态
  loading: LoadingState

  // 视图操作
  navigateTo(view: ViewType): void
  goBack(): void

  // 弹窗队列操作
  enqueueDialog<T>(request: DialogRequest<T>): Promise<T>
  resolveDialog(result: unknown): void
  cancelDialog(): void

  // 加载状态
  setLoading(phase: LoadingPhase, message?: string): void
}

// 弹窗队列状态
interface DialogState {
  current: DialogRequest | null   // 当前显示的弹窗
  queue: DialogRequest[]          // 等待队列
}

// 弹窗请求
interface DialogRequest<T = unknown> {
  id: string
  type: DialogType
  data?: DialogData
  priority: 'high' | 'normal'
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}
```

#### SessionContext

```typescript
interface SessionContextValue {
  // 状态
  sessionId: string | null
  sessionName: string | null
  messages: MessageWithParts[]
  tokenCount: number

  // 操作
  refreshMessages(): Promise<void>
  clearMessages(): void
}
```

#### ConfigContext

```typescript
interface ConfigContextValue {
  // 只读状态（由外部模块驱动更新）
  modelName: string
  mode: 'ask' | 'plan' | 'agent'
  agentState: 'ask-before-edit' | 'edit-automatically'
  workingDirectory: string
}
```

#### KeypressContext

```typescript
interface KeypressContextValue {
  lastKey: KeyInfo | null
  registerShortcut(key: string, handler: () => void): void
  unregisterShortcut(key: string): void
}
```

### 3.3 Hook 接口

#### useInput

```typescript
/**
 * 输入处理 hook
 */
function useInput(): {
  handleSubmit: (text: string) => Promise<void>
  isProcessing: boolean
}
```

#### useStream

```typescript
/**
 * 流式响应订阅 hook
 */
function useStream(sessionId: string): {
  isStreaming: boolean
}
```

#### useKeyboard

```typescript
/**
 * 键盘快捷键 hook
 */
function useKeyboard(): {
  registerShortcut: (key: string, handler: () => void) => void
  unregisterShortcut: (key: string) => void
}
```

#### useHistory

```typescript
/**
 * 输入历史 hook
 */
function useHistory(): {
  history: HistoryItem[]
  currentIndex: number
  navigateUp: () => string | null
  navigateDown: () => string | null
  addToHistory: (text: string) => void
}
```

#### usePermission

```typescript
/**
 * 权限对话框 hook
 */
function usePermission(): {
  currentRequest: PermissionInfo | null
  respond: (response: PermissionResponse) => void
}
```

#### useCompletion

```typescript
/**
 * Tab 自动补全 hook
 */
function useCompletion(input: string): {
  // 状态
  suggestions: Completion[]
  selectedIndex: number
  visible: boolean

  // 操作
  selectNext: () => void
  selectPrev: () => void
  apply: () => string | null       // 返回补全后的文本
  dismiss: () => void
}

interface Completion {
  text: string                      // 补全文本
  displayText: string               // 显示文本（可能带高亮）
  description?: string              // 描述信息
}
```

#### useDialogQueue

```typescript
/**
 * 弹窗队列管理 hook
 */
function useDialogQueue(): {
  // 状态
  current: DialogRequest | null
  queueLength: number

  // 操作
  enqueue: <T>(type: DialogType, data?: DialogData, priority?: 'high' | 'normal') => Promise<T>
  resolve: (result: unknown) => void
  cancel: () => void
}
```

#### useVirtualizedList

```typescript
/**
 * 虚拟化列表 hook
 */
function useVirtualizedList<T>(options: {
  items: T[]
  containerHeight: number
  estimateItemHeight: (item: T, index: number) => number
  overscan?: number                 // 额外渲染的项目数，默认 3
}): {
  // 状态
  visibleItems: Array<{ item: T; index: number; style: ItemStyle }>
  totalHeight: number
  scrollTop: number

  // 操作
  scrollTo: (offset: number) => void
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void
  scrollToBottom: () => void

  // 事件处理
  onScroll: (event: ScrollEvent) => void
}

interface ItemStyle {
  position: 'absolute'
  top: number
  height: number
  width: '100%'
}
```

#### useLoading

```typescript
/**
 * 加载状态 hook
 */
function useLoading(): {
  // 状态
  phase: LoadingPhase
  message: string | null
  toolName: string | null

  // 显示文本
  displayText: string               // 根据 phase 生成显示文本
}

type LoadingPhase = 'idle' | 'thinking' | 'executing' | 'streaming'

// 显示文本映射：
// - idle: ""
// - thinking: "✦ Thinking..."
// - executing: "⠋ Executing tool: {toolName}"
// - streaming: ""（直接显示流式内容）
```

### 3.4 组件 Props 接口

#### Message

```typescript
interface MessageProps {
  message: Message
  parts: Part[]
  onToggleReasoning?: (partId: string) => void
  expandedReasoningParts?: Set<string>
}
```

#### Prompt

```typescript
interface PromptProps {
  onSubmit: (text: string) => void
  disabled?: boolean
  placeholder?: string
}
```

#### StatusBar

```typescript
interface StatusBarProps {
  data: StatusBarData
}
```

#### PermissionDialog

```typescript
interface PermissionDialogProps {
  data: PermissionDialogData
  onRespond: (response: PermissionResponse) => void
  onCancel: () => void
}
```

#### DialogManager

```typescript
interface DialogManagerProps {
  // 由 AppContext 提供，通常不需要显式传入
}

// DialogManager 内部根据 current.type 路由到具体弹窗组件：
// - type: 'permission' → PermissionDialog
// - type: 'model' → ModelDialog
// - type: 'session' → SessionDialog
// - type: 'confirm' → ConfirmDialog
```

#### VirtualizedList

```typescript
interface VirtualizedListProps<T> {
  items: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  estimateItemHeight: (item: T, index: number) => number
  containerHeight: number
  overscan?: number                 // 默认 3
  autoScrollToBottom?: boolean      // 默认 true
  onScroll?: (scrollTop: number) => void
}
```

#### MessageList

```typescript
interface MessageListProps {
  messages: MessageWithParts[]
  expandedReasoningParts?: Set<string>
  onToggleReasoning?: (partId: string) => void
}
```

#### 消息类型组件

```typescript
// 用户消息组件
interface UserMessageProps {
  message: Message
  parts: Part[]
}

// 助手消息组件
interface AssistantMessageProps {
  message: Message
  parts: Part[]
  expandedReasoningParts?: Set<string>
  onToggleReasoning?: (partId: string) => void
}

// 系统消息组件
interface SystemMessageProps {
  message: Message
  kind: 'abort' | 'error' | 'info'
}
```

#### LoadingIndicator

```typescript
interface LoadingIndicatorProps {
  phase: LoadingPhase
  toolName?: string
  message?: string
}

// 渲染逻辑：
// - phase: 'idle' → 不渲染
// - phase: 'thinking' → <Text color="cyan">✦ Thinking...</Text>
// - phase: 'executing' → <Spinner /> <Text>Executing tool: {toolName}</Text>
// - phase: 'streaming' → 不渲染（内容直接流式显示）
```

### 3.5 外部模块调用接口

#### cli/commands

```typescript
// ui 调用 cli/commands 执行 slash 命令
import { executeSlashCommand, getCompletions } from '@/cli/commands'

// 执行命令
const result = await executeSlashCommand('/model list')
// result: SlashCommandResult

// 获取自动补全建议
const completions = getCompletions('/mod')
// completions: Completion[]
// 返回: [{ text: 'el', displayText: 'model', description: '切换模型' }]
```

#### lifecycle

```typescript
// ui 调用 lifecycle 执行普通对话
import { lifecycle } from '@/core/lifecycle'

await lifecycle.execute(sessionId, text)
```

#### permission

```typescript
// ui 调用 permission 返回确认结果
import { Permission } from '@/permission'

Permission.respond(sessionId, permissionId, response)
```

### 3.6 Bus 事件订阅

```typescript
// ui 订阅的事件列表

// 消息相关
Bus.subscribe('Message.Event.Updated', handler)       // 消息元数据更新
Bus.subscribe('Message.Event.PartUpdated', handler)   // Part 内容更新（含流式 delta）
Bus.subscribe('Message.Event.Removed', handler)       // 消息删除

// 权限相关
Bus.subscribe('Permission.Event.Updated', handler)    // 权限确认请求

// 策略相关
Bus.subscribe('Policy.Event.ModeChanged', handler)    // 模式切换（ask/plan/agent）
Bus.subscribe('Policy.Event.AgentStateChanged', handler)  // Agent 状态变更

// 生命周期相关
Bus.subscribe('Lifecycle.Event.Started', handler)     // 执行开始 → LoadingPhase: thinking
Bus.subscribe('Lifecycle.Event.ToolExecuting', handler)  // 工具执行中 → LoadingPhase: executing
Bus.subscribe('Lifecycle.Event.Streaming', handler)   // 流式响应中 → LoadingPhase: streaming
Bus.subscribe('Lifecycle.Event.Completed', handler)   // 执行完成 → LoadingPhase: idle
Bus.subscribe('Lifecycle.Event.Aborted', handler)     // 执行中断 → 显示中断消息

// 上下文相关
Bus.subscribe('Context.Event.UsageUpdated', handler)  // 上下文使用量更新
Bus.subscribe('Context.Event.Compressed', handler)    // 自动压缩完成通知
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据归属表

| 数据 | 创建者 | 更新者 | 读取者 | 销毁者 |
|------|--------|--------|--------|--------|
| ViewState | ui/AppContext | ui/AppContext | ui/views | ui/AppContext |
| DialogState (队列) | ui/AppContext | ui/useDialogQueue | ui/DialogManager | ui/AppContext |
| LoadingState | ui/AppContext | ui/useLoading | ui/LoadingIndicator | ui/AppContext |
| messages 缓存 | message 模块 | ui/SessionContext | ui/MessageList | ui/SessionContext |
| PromptState | ui/Prompt | ui/Prompt | ui/Prompt | ui/Prompt |
| CompletionState | ui/useCompletion | ui/useCompletion | ui/Prompt | ui/useCompletion |
| VirtualizedState | ui/useVirtualizedList | ui/useVirtualizedList | ui/VirtualizedList | ui/useVirtualizedList |
| 输入历史 | ui/useHistory | ui/useHistory | ui/Prompt | ui/useHistory |

### 4.2 责任边界

| 场景 | ui 的责任 | 其他模块的责任 |
|------|-----------|---------------|
| 消息显示 | 类型路由、虚拟化渲染、缓存管理 | message 模块负责存储 |
| 命令执行 | 收集输入、显示结果 | cli/commands 负责解析执行 |
| 命令补全 | 显示补全建议、处理 Tab 键 | cli/commands 负责提供补全列表 |
| 权限确认 | 弹窗队列管理、收集响应 | permission 负责逻辑判断 |
| 模式切换 | 显示当前模式 | policy 负责模式管理 |
| 配置显示 | 读取并显示 | config 负责加载和存储 |
| 加载状态 | 根据事件切换显示状态 | lifecycle 负责发布状态事件 |
| 列表滚动 | 虚拟化渲染、自动滚动 | - |

### 4.3 状态一致性保证

1. **消息一致性**：SessionContext 订阅 Bus 事件，确保缓存与 message 模块同步
2. **配置一致性**：ConfigContext 订阅 Policy 事件，确保显示与实际状态同步
3. **弹窗队列一致性**：Promise-based 设计确保每个请求都有响应，队列按序处理
4. **加载状态一致性**：Lifecycle 事件驱动状态转换，确保显示与执行状态同步
5. **虚拟化一致性**：消息更新时重新计算可见范围，确保显示与数据同步

---

## 五、交互时序图

### 5.1 普通对话时序

```
User          Prompt        useInput      lifecycle       Bus         Message
  │              │              │              │            │            │
  │─── 输入文本 ──▶│              │              │            │            │
  │              │─── submit ──▶│              │            │            │
  │              │              │─── execute ──▶│            │            │
  │              │              │              │── Event ──▶│            │
  │              │              │              │            │─── update ─▶│
  │              │◀──────────────────────────────────────────── render ──│
  │◀── 看到响应 ──│              │              │            │            │
```

### 5.2 权限确认时序

```
Tool        Permission       Bus        usePermission   Dialog        User
  │              │            │              │            │            │
  │─── ask() ───▶│            │              │            │            │
  │              │── Event ──▶│              │            │            │
  │              │            │─── notify ──▶│            │            │
  │              │            │              │─── open ──▶│            │
  │              │            │              │            │◀── 选择 ────│
  │              │◀───────────────────────────── respond ─│            │
  │◀── resolve ──│            │              │            │            │
```

### 5.3 Tab 自动补全时序

```
User         Prompt      useCompletion   cli/commands
  │              │              │              │
  │── 输入 /mod ─▶│              │              │
  │              │── onChange ──▶│              │
  │              │              │── getCompletions ──▶│
  │              │              │◀── [completions] ───│
  │              │◀── render ───│              │
  │◀── 显示 /mod|el ─────────────│              │
  │              │              │              │
  │── 按 Tab ───▶│              │              │
  │              │─── apply() ──▶│              │
  │              │◀── "/model" ──│              │
  │◀── 显示 /model ──────────────│              │
```

### 5.4 弹窗队列时序

```
Event1       Event2      DialogManager     Dialog        User
  │              │              │            │            │
  │── enqueue ──▶│              │            │            │
  │              │              │─ current ─▶│            │
  │              │              │            │◀── 响应 ───│
  │              │── enqueue ──▶│            │            │
  │              │              │◀── resolve ─│            │
  │              │              │─ dequeue ──▶│            │
  │              │              │            │◀── 响应 ───│
  │              │              │◀── resolve ─│            │
```

### 5.5 加载状态时序

```
User       Prompt     lifecycle      Bus       useLoading    Indicator
  │          │            │           │            │            │
  │── 输入 ──▶│            │           │            │            │
  │          │── execute ─▶│           │            │            │
  │          │            │─ Started ─▶│            │            │
  │          │            │           │── notify ──▶│            │
  │          │            │           │            │── thinking ─▶│
  │◀─────────────────────────────────────────────── ✦ Thinking... │
  │          │            │           │            │            │
  │          │            │─ToolExec ─▶│            │            │
  │          │            │           │── notify ──▶│            │
  │          │            │           │            │─ executing ─▶│
  │◀────────────────────────────────────────────── ⠋ Executing... │
  │          │            │           │            │            │
  │          │            │─ Streaming ▶│            │            │
  │          │            │           │── notify ──▶│            │
  │          │            │           │            │─ streaming ─▶│
  │◀──────────────────────────────────────────────── (流式内容)    │
  │          │            │           │            │            │
  │          │            │─ Complete ─▶│            │            │
  │          │            │           │── notify ──▶│            │
  │          │            │           │            │─── idle ───▶│
```

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 接口定义关注"语义"而非具体实现
- [x] 与 goals-duty.md 和 architecture.md 保持一致
- [x] 新增：Tab 自动补全数据流和接口已定义
- [x] 新增：弹窗队列管理数据流和接口已定义
- [x] 新增：虚拟化列表数据流和接口已定义
- [x] 新增：加载状态数据流和接口已定义
- [x] 新增：消息类型路由数据流已描述
- [x] 新增：时序图覆盖所有关键交互场景
