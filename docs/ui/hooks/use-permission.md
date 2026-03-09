# usePermission 权限弹窗 Hook

本文档定义 usePermission 的职责、接口和与 DialogManager 的协作方式。

usePermission 订阅权限请求事件，将权限确认弹窗加入 AppStateContext 的弹窗队列，并处理用户的确认/拒绝响应。

---

## 一、职责

- 订阅 `Permission.Event.Updated` Bus 事件
- 将权限请求转换为弹窗请求，加入弹窗队列
- 提供响应方法，将用户的确认/拒绝回传给 permission 模块

---

## 二、签名

```typescript
function usePermission(): void
```

无参数，无返回值。纯副作用 Hook。

权限响应通过弹窗的 `onRespond` 回调传递，不需要从 Hook 返回。

---

## 三、调用位置

**DialogManager 组件**（唯一调用位置）

```tsx
function DialogManager() {
  usePermission()   // 订阅权限事件，入队弹窗

  const appState = useContext(AppStateContext)
  const { closeCurrentDialog } = useContext(AppActionsContext)

  if (!appState.dialog.current) return null

  switch (appState.dialog.current.type) {
    case 'permission':
      return <PermissionDialog
        data={appState.dialog.current.data}
        onClose={closeCurrentDialog}
      />
    // ...其他弹窗类型
  }
}
```

---

## 四、事件处理流程

```
permission 模块检测到工具需要授权
    |
    v
Bus.publish(Permission.Event.Updated, {
  permissionId: string,
  sessionId: string,
  toolName: string,
  title: string,
  description: string,
  metadata?: Record<string, unknown>
})
    |
    v
usePermission 接收事件
    |
    v
enqueueDialog({
  type: 'permission',
  data: {
    type: 'permission',
    permissionId: payload.permissionId,
    sessionId: payload.sessionId,
    title: payload.title,
    description: payload.description,
    toolName: payload.toolName,
    metadata: payload.metadata,
  },
  priority: 'high',                    // 权限弹窗高优先级
  onRespond: (result) => {
    Permission.respond(payload.permissionId, result)
  },
  onCancel: () => {
    Permission.respond(payload.permissionId, { allowed: false })
  },
})
    |
    v
DialogManager 显示 PermissionDialog
    |
    v
用户点击 Allow 或 Deny
    |
    v
onRespond({ allowed: true/false }) 被调用
    |
    v
Permission.respond() 将结果回传给 permission 模块
    |
    v
closeCurrentDialog() -> 显示队列中下一个弹窗
```

---

## 五、实现要点

```typescript
function usePermission(): void {
  const { enqueueDialog } = useContext(AppActionsContext)

  useEffect(() => {
    const unsub = Bus.subscribe(Permission.Event.Updated, (payload) => {
      enqueueDialog({
        type: 'permission',
        data: {
          type: 'permission',
          permissionId: payload.permissionId,
          sessionId: payload.sessionId,
          title: payload.title,
          description: payload.description,
          toolName: payload.toolName,
          metadata: payload.metadata,
        },
        priority: 'high',
        onRespond: (result) => {
          Permission.respond(payload.permissionId, result as PermissionResponse)
        },
        onCancel: () => {
          Permission.respond(payload.permissionId, { allowed: false })
        },
      })
    })

    return unsub
  }, [enqueueDialog])
}
```

**关键**：
- 权限弹窗使用 `priority: 'high'`，插入队列头部
- `onCancel` 默认拒绝，确保取消操作也有明确响应
- `enqueueDialog` 通过 useMemo 稳定化，不会导致 useEffect 重新执行

---

## 六、为什么 usePermission 不返回 currentRequest？

在早期设计中，usePermission 返回 `{ currentRequest, respond }`。但在弹窗队列模式下：
- 权限请求通过 `enqueueDialog` 进入统一的弹窗队列
- 当前弹窗状态由 `AppStateContext.dialog.current` 管理
- DialogManager 根据 `dialog.current.type` 渲染对应弹窗组件

usePermission 只需要做"事件 -> 入队"的转换，不需要维护独立的状态。弹窗的生命周期由 AppStateContext 统一管理。

---

## 七、依赖关系

| 依赖 | 类型 | 用途 |
|------|------|------|
| Bus | 事件订阅 | 订阅 Permission.Event.Updated |
| AppActionsContext | 写 | 调用 enqueueDialog 入队弹窗 |
| permission 模块 | 调用 | Permission.respond() 回传响应 |

---

## 八、文档自检

- [x] 签名完整
- [x] 调用位置已明确（DialogManager，唯一）
- [x] 事件处理流程有完整的数据流图
- [x] 弹窗入队参数已详细定义
- [x] 高优先级和取消处理已说明
- [x] 不返回状态的设计理由已解释
- [x] 与弹窗队列模式的协作已说明
