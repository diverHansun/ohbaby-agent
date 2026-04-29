# AppActionsContext — 应用动作

本文档定义 AppActionsContext 的行为接口与实现规范。

AppActionsContext 是 State/Action 分离模式的写入侧，提供修改 AppStateContext 状态的 action 函数。

---

## 一、职责

提供修改应用状态的行为接口：

- **视图导航**：切换视图、返回上一视图。
- **弹窗队列操作**：入队弹窗、关闭当前弹窗。
- **加载状态控制**：设置加载阶段和附加信息。

本 Context 只包含 action 函数，不包含状态数据。

---

## 二、Action 定义

```typescript
interface AppActionsContextValue {
  navigateTo: (view: ViewType) => void
  goBack: () => void
  enqueueDialog: (request: Omit<DialogRequest, 'id'>) => string
  closeCurrentDialog: () => void
  setLoading: (state: Partial<LoadingState>) => void
}
```

---

## 三、Action 行为规范

### 3.1 navigateTo(view)

将当前视图存入 `previous`，将目标视图设为 `current`。目标与当前相同时不执行。

### 3.2 goBack()

切换到 `previous` 视图。`previous` 不存在时不执行。返回后清除 `previous`。

### 3.3 enqueueDialog(request)

将弹窗请求加入队列。生成唯一 ID 并返回。

`request` 使用新的 `DialogRequest` 结构：

```typescript
enqueueDialog({
  source: 'permission',
  request: permissionRequest,
  priority: 'high',
  onRespond: (result) => client.respondPermission(requestId, result),
})

enqueueDialog({
  source: 'interaction',
  request: interactionRequest,
  priority: 'normal',
  onRespond: (result) => client.respondInteraction(interactionId, result),
})
```

`source` 区分来源（permission vs interaction），DialogManager 据此选择渲染路径。

### 3.4 closeCurrentDialog()

关闭当前弹窗，从队列取出下一个。

### 3.5 setLoading(state)

合并传入的部分状态到当前 LoadingState。`phase !== 'idle'` 时自动设 `isLoading: true`。

---

## 四、消费者清单

| 消费者 | 使用的 Action | 场景 |
|---|---|---|
| useInput | `navigateTo` | 用户提交输入后切换到 chat 视图 |
| useKeyboard | `goBack`, `closeCurrentDialog` | Esc 键返回、关闭弹窗 |
| useStream | `setLoading` | 根据 SDK `run.updated` 事件更新加载阶段 |
| usePermission | `enqueueDialog`, `closeCurrentDialog` | SDK `permission.requested` 入队弹窗 |
| useInteraction | `enqueueDialog`, `closeCurrentDialog` | SDK `interaction.requested` 入队弹窗 |

---

## 五、依赖关系

AppActionsProvider 是最内层 Provider，可以访问所有外层 Context。

```
AppActionsProvider
   ├── 读取 AppStateContext（获取当前状态以计算下一状态）
   └── 内部持有 setState（通过模块内部共享获取）
```

不再依赖 SessionContext（已收编到 TuiStore）。需要会话信息时通过 TuiStore selector 获取。

---

## 六、Provider 实现要点

```tsx
export function AppActionsProvider({ children }: { children: React.ReactNode }) {
  const actions = useMemo<AppActionsContextValue>(() => ({
    navigateTo: (view) => { /* setState(prev => ...) */ },
    goBack: () => { /* setState(prev => ...) */ },
    enqueueDialog: (request) => { /* ... */ },
    closeCurrentDialog: () => { /* ... */ },
    setLoading: (state) => { /* ... */ },
  }), [])

  return (
    <AppActionsContext.Provider value={actions}>
      {children}
    </AppActionsContext.Provider>
  )
}
```

`useMemo` 空依赖数组，确保 action 引用永远不变。action 内部通过 `setState(prev => ...)` 函数式更新读取最新状态。

---

## 七、文档自检

- [x] 所有 action 的签名和行为规范已定义。
- [x] enqueueDialog 使用新的 `source: 'permission' | 'interaction'` 结构。
- [x] 消费者清单包含 useInteraction（新增）。
- [x] 不再依赖 SessionContext。
- [x] Provider 实现的 useMemo 稳定化已说明。
