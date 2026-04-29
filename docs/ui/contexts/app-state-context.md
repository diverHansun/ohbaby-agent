# AppStateContext — 应用只读状态

本文档定义 AppStateContext 的状态结构与使用规范。

AppStateContext 是 State/Action 分离模式的只读侧，提供纯 UI 控制状态的读取接口。状态变更由 AppActionsContext 负责。

---

## 一、职责

提供应用级只读状态：

- **视图状态**：当前显示的视图和历史记录。
- **弹窗队列状态**：当前弹窗和等待队列。
- **加载状态**：当前加载阶段和附加信息。

本 Context 不包含 SDK 投影数据（runtime/messages/catalog 等归 TuiStore）。

---

## 二、State 定义

```typescript
interface AppStateContextValue {
  view: ViewState
  dialog: DialogState
  loading: LoadingState
}
```

### 2.1 ViewState

```typescript
type ViewType = 'home' | 'chat' | 'help'

interface ViewState {
  current: ViewType
  previous?: ViewType
}
```

初始值：`{ current: 'home', previous: undefined }`

转换规则：
- `home → chat`：用户提交第一条消息。
- `chat → help`：用户通过全局帮助入口或 HelpView 导航。
- `help → chat`：用户按 Esc 返回。
- `* → home`：用户执行 `/session clear` 或 catalog 声明的 `/clear` alias 清空会话。

### 2.2 DialogState

```typescript
interface DialogState {
  queue: DialogRequest[]
  current: DialogRequest | null
}

interface DialogRequest {
  id: string
  source: 'permission' | 'interaction'
  request: UiPermissionRequest | UiInteractionRequest
  priority: 'high' | 'normal'
  onRespond?: (result: unknown) => void
  onCancel?: () => void
}
```

初始值：`{ queue: [], current: null }`

队列行为：
- `current` 为 null 时，新弹窗直接成为 `current`。
- `current` 不为 null 时，新弹窗加入 `queue`。
- `priority: 'high'` 的弹窗插入 `queue` 头部，但不打断当前弹窗。
- 用户响应后，`current` 出队，`queue` 头部成为新 `current`。

**注意**：`source` 字段区分弹窗来源（permission vs interaction），替代旧设计中的 `type: 'permission' | 'model' | 'session' | 'confirm'`。interaction 内部按 `kind + subject` 二次派发到具体 renderer，由 DialogManager 负责。

### 2.3 LoadingState

```typescript
interface LoadingState {
  isLoading: boolean
  phase: 'idle' | 'thinking' | 'executing' | 'streaming'
  message?: string
  toolName?: string
}
```

初始值：`{ isLoading: false, phase: 'idle' }`

状态转换由 `useStream` 根据 SDK `run.updated` 事件驱动：
- `run.updated(status: running)` → `thinking`
- `run.updated` 含 tool execution 信息 → `executing`
- `message.part.delta` 到达 → `streaming`
- `run.updated(status: completed/failed/cancelled)` → `idle`

---

## 三、消费者清单

| 消费者 | 读取的状态 | 用途 |
|---|---|---|
| Router | `view.current` | 渲染对应 View |
| DialogManager | `dialog.current`, `dialog.queue` | 显示当前弹窗 |
| LoadingIndicator | `loading` | 显示加载动画 |
| StatusBar | `loading.phase` | 显示当前状态 |
| useKeyboard | `view.current`, `dialog.current` | 根据视图/弹窗状态决定快捷键行为 |
| Prompt | `dialog.current` | 弹窗显示时冻结输入 |

---

## 四、更新时机

AppStateContext 的状态仅通过 AppActionsContext 的 action 函数更新：

| 状态 | 更新触发者 | 通过的 Action |
|---|---|---|
| `view` | useInput（用户输入触发导航） | `navigateTo()`, `goBack()` |
| `dialog` | usePermission / useInteraction（SDK 事件入队） | `enqueueDialog()`, `closeCurrentDialog()` |
| `loading` | useStream（SDK `run.updated` 事件） | `setLoading()` |

---

## 五、设计理由

### 为什么 ViewState、DialogState、LoadingState 放在同一 Context？

这三个状态存在交互关系：弹窗打开时某些视图导航应被阻止；加载中时弹窗优先级判断需要参考加载阶段。放在同一 Context 中，AppActionsContext 的 action 函数可以原子性地更新相关状态。

### 为什么 LoadingState 不放 TuiStore？

LoadingState 是 UI 展示状态（"显示什么加载动画"），不是 SDK 数据投影。它由 useStream 根据 SDK 事件派生，但派生逻辑和最终值属于 UI 层决策。

---

## 六、文档自检

- [x] 所有状态字段有明确的类型定义和初始值。
- [x] 不包含 SDK 投影数据（已收编到 TuiStore）。
- [x] DialogState 使用 `source: 'permission' | 'interaction'` 替代旧的 4 种 type。
- [x] LoadingState 由 SDK 事件驱动，不由 useInput 主动设置。
- [x] 消费者清单完整。
