# AppStateContext 应用只读状态

本文档定义 AppStateContext 的状态结构与使用规范。

AppStateContext 是 State/Action 分离模式的只读侧，提供应用级状态的读取接口。状态变更由 [AppActionsContext](./app-actions-context.md) 负责。

---

## 一、职责

提供应用级只读状态，包括：

- **视图状态**：当前显示的视图和历史记录
- **弹窗队列状态**：当前弹窗和等待队列
- **加载状态**：当前加载阶段和附加信息

本 Context 不包含任何 action 函数。消费者只需读取状态，不会因 action 引用变化而重渲染。

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
  current: ViewType        // 当前视图
  previous?: ViewType      // 上一个视图（用于 goBack）
}
```

**初始值**：`{ current: 'home', previous: undefined }`

**转换规则**：
- `home -> chat`：用户提交第一条消息
- `chat -> help`：用户执行 `/help` 命令
- `help -> chat`：用户按 Esc 返回
- `* -> home`：用户执行 `/clear` 清空会话

### 2.2 DialogState

```typescript
interface DialogState {
  queue: DialogRequest[]         // 等待队列
  current: DialogRequest | null  // 当前显示的弹窗
}

interface DialogRequest {
  id: string                     // 唯一 ID（由 enqueueDialog 生成）
  type: DialogType               // 弹窗类型
  data: DialogData               // 弹窗数据
  priority: DialogPriority       // 优先级
  onRespond?: (result: unknown) => void  // 响应回调
  onCancel?: () => void          // 取消回调
}

type DialogType = 'permission' | 'model' | 'session' | 'confirm'
type DialogPriority = 'high' | 'normal' | 'low'
```

**初始值**：`{ queue: [], current: null }`

**队列行为**：
- `current` 为 null 时，新弹窗直接成为 `current`
- `current` 不为 null 时，新弹窗加入 `queue`
- `priority: 'high'` 的弹窗插入 `queue` 头部，但不打断当前弹窗
- 用户响应后，`current` 出队，`queue` 头部成为新 `current`

### 2.3 LoadingState

```typescript
interface LoadingState {
  isLoading: boolean
  phase: 'idle' | 'thinking' | 'executing' | 'streaming'
  message?: string          // 加载提示文本
  toolName?: string         // phase = 'executing' 时显示的工具名
}
```

**初始值**：`{ isLoading: false, phase: 'idle' }`

**状态转换**：

```
idle ──(lifecycle.execute 调用)──> thinking
thinking ──(收到第一个 token)──> streaming
streaming ──(遇到 tool_call)──> executing
executing ──(工具执行完毕)──> streaming 或 thinking
streaming ──(finish_reason: stop)──> idle
* ──(中断/错误)──> idle
```

**显示映射**：
- `thinking`：显示 Spinner + "Thinking..."
- `executing`：显示 Spinner + "Executing tool: {toolName}"
- `streaming`：无额外提示，直接显示流式内容
- `idle`：不显示加载状态

---

## 三、消费者清单

| 消费者 | 读取的状态 | 用途 |
|--------|-----------|------|
| Router（App.tsx） | `view.current` | 根据视图类型渲染对应 View |
| DialogManager | `dialog.current`, `dialog.queue` | 显示当前弹窗 |
| Spinner | `loading` | 显示加载动画和提示 |
| StatusBar | `loading.phase` | 显示当前状态 |
| useKeyboard | `view.current`, `dialog.current` | 根据视图/弹窗状态决定快捷键行为 |

---

## 四、更新时机

AppStateContext 的状态**仅通过 AppActionsContext 的 action 函数更新**，不接受直接修改。

| 状态 | 更新触发者 | 通过的 Action |
|------|-----------|--------------|
| `view` | useInput（用户输入触发导航） | `navigateTo()`, `goBack()` |
| `dialog` | usePermission（权限事件）、useInput（slash 命令） | `enqueueDialog()`, `closeCurrentDialog()` |
| `loading` | useStream（Bus 事件） | `setLoading()` |

---

## 五、Provider 实现要点

```tsx
export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppStateContextValue>({
    view: { current: 'home' },
    dialog: { queue: [], current: null },
    loading: { isLoading: false, phase: 'idle' },
  })

  return (
    <AppStateContext.Provider value={state}>
      {/* setState 通过内部机制传递给 AppActionsProvider，不暴露在 Context 中 */}
      {children}
    </AppStateContext.Provider>
  )
}
```

**关键**：`setState` 不通过 AppStateContext 暴露。AppActionsProvider 通过模块内部共享（如 React ref 或闭包）获取 `setState`，保证外部消费者无法直接修改状态。

---

## 六、设计理由

### 为什么不把 ViewState、DialogState、LoadingState 拆成独立 Context？

这三个状态存在交互关系：
- 弹窗打开时，某些视图导航应被阻止
- 加载中时，弹窗优先级判断需要参考加载阶段

放在同一 Context 中，AppActionsContext 的 action 函数可以原子性地更新相关状态，避免跨 Context 同步问题。

### 为什么 LoadingState 放在 AppStateContext 而不是 SessionContext？

LoadingState 描述的是 UI 层面的展示状态（"显示什么加载动画"），不是业务数据。它由 useStream 根据 Bus 事件设置，由 Spinner 组件消费。与消息数据（SessionContext）分离，职责更清晰。

---

## 七、文档自检

- [x] 所有状态字段有明确的类型定义和初始值
- [x] 状态转换规则已说明
- [x] 消费者清单完整
- [x] 更新时机和触发者已明确
- [x] 与 AppActionsContext 的分工已说明
- [x] 设计理由已解释
