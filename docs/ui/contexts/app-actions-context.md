# AppActionsContext 应用动作

本文档定义 AppActionsContext 的行为接口与实现规范。

AppActionsContext 是 State/Action 分离模式的写入侧，提供修改 [AppStateContext](./app-state-context.md) 状态的 action 函数。

---

## 一、职责

提供修改应用状态的行为接口：

- **视图导航**：切换视图、返回上一视图
- **弹窗队列操作**：入队弹窗、关闭当前弹窗
- **加载状态控制**：设置加载阶段和附加信息

本 Context 只包含 action 函数，不包含状态数据。需要读取状态的消费者应使用 AppStateContext。

---

## 二、Action 定义

```typescript
interface AppActionsContextValue {
  // 视图导航
  navigateTo: (view: ViewType) => void
  goBack: () => void

  // 弹窗队列
  enqueueDialog: (request: Omit<DialogRequest, 'id'>) => string  // 返回生成的 ID
  closeCurrentDialog: () => void

  // 加载状态
  setLoading: (state: Partial<LoadingState>) => void
}
```

---

## 三、Action 行为规范

### 3.1 navigateTo(view)

切换到指定视图。

**行为**：
- 将当前视图存入 `previous`
- 将目标视图设为 `current`
- 如果目标视图与当前视图相同，不执行操作

```typescript
navigateTo('chat')
// before: { current: 'home', previous: undefined }
// after:  { current: 'chat', previous: 'home' }
```

### 3.2 goBack()

返回上一个视图。

**行为**：
- 如果 `previous` 存在，切换到 `previous`
- 如果 `previous` 不存在，不执行操作
- 返回后清除 `previous`

```typescript
goBack()
// before: { current: 'help', previous: 'chat' }
// after:  { current: 'chat', previous: undefined }
```

### 3.3 enqueueDialog(request)

将弹窗请求加入队列。

**行为**：
- 生成唯一 ID（如 `crypto.randomUUID()`）
- 如果 `current` 为 null，直接设为 `current`
- 如果 `current` 不为 null：
  - `priority: 'high'` → 插入 `queue` 头部
  - `priority: 'normal' | 'low'` → 追加到 `queue` 末尾
- 返回生成的 ID

```typescript
const id = enqueueDialog({
  type: 'permission',
  data: permissionData,
  priority: 'high',
  onRespond: handleResponse,
})
```

### 3.4 closeCurrentDialog()

关闭当前弹窗，显示队列中下一个。

**行为**：
- 如果 `queue` 非空，取出头部作为新 `current`
- 如果 `queue` 为空，将 `current` 设为 null

### 3.5 setLoading(state)

更新加载状态。

**行为**：
- 合并传入的部分状态到当前 LoadingState
- 自动计算 `isLoading`：`phase !== 'idle'` 时为 true

```typescript
setLoading({ phase: 'thinking' })
// result: { isLoading: true, phase: 'thinking' }

setLoading({ phase: 'executing', toolName: 'read_file' })
// result: { isLoading: true, phase: 'executing', toolName: 'read_file' }

setLoading({ phase: 'idle' })
// result: { isLoading: false, phase: 'idle', toolName: undefined, message: undefined }
```

---

## 四、消费者清单

| 消费者 | 使用的 Action | 场景 |
|--------|-------------|------|
| useInput | `navigateTo`, `setLoading` | 用户提交输入后切换到 chat 视图、设置加载 |
| useKeyboard | `goBack`, `closeCurrentDialog` | Esc 键返回、关闭弹窗 |
| useStream | `setLoading` | 根据 Bus 事件更新加载阶段 |
| usePermission | `enqueueDialog`, `closeCurrentDialog` | 权限请求入队弹窗 |

---

## 五、依赖关系

```
AppActionsProvider
     |
     +-- 读取 AppStateContext（获取当前状态以计算下一状态）
     +-- 读取 SessionContext（部分 action 需要会话信息）
     |
     v
  内部持有 setState（通过模块内部共享获取）
```

AppActionsProvider 是最内层 Provider，可以访问所有外层 Context。

---

## 六、Provider 实现要点

```tsx
export function AppActionsProvider({ children }: { children: React.ReactNode }) {
  const appState = useContext(AppStateContext)
  // setState 通过模块内部共享机制获取（如 useRef 传递）

  const actions = useMemo<AppActionsContextValue>(() => ({
    navigateTo: (view) => { /* ... */ },
    goBack: () => { /* ... */ },
    enqueueDialog: (request) => { /* ... */ },
    closeCurrentDialog: () => { /* ... */ },
    setLoading: (state) => { /* ... */ },
  }), [])  // 空依赖：action 引用永远稳定

  return (
    <AppActionsContext.Provider value={actions}>
      {children}
    </AppActionsContext.Provider>
  )
}
```

**关键**：`useMemo` 空依赖数组，确保 action 引用永远不变。action 内部通过 `setState(prev => ...)` 函数式更新读取最新状态，不需要依赖外部变量。

---

## 七、设计理由

### 为什么 action 引用需要稳定化？

如果 action 引用每次渲染都变化，所有消费 AppActionsContext 的组件都会重渲染。通过 `useMemo([])` 稳定引用，消费者只在自己关心的状态变化时重渲染。

### 为什么 AppActionsProvider 在最内层？

AppActionsProvider 的 action 函数需要访问 AppStateContext 和 SessionContext 来做状态决策（如 `goBack` 需要读取 `previous` 视图）。放在最内层，可以 `useContext` 获取所有外层 Context。

---

## 八、文档自检

- [x] 所有 action 的签名、参数、返回值已定义
- [x] 每个 action 的行为规范有示例
- [x] 消费者清单完整
- [x] 与 AppStateContext 的分工边界清晰
- [x] Provider 实现的关键点（useMemo 稳定化）已说明
- [x] 依赖关系已说明
