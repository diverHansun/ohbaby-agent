# usePermission — 权限弹窗桥接 Hook

本文档定义 usePermission 的职责和与 DialogManager 的协作方式。

usePermission 监听 TuiStore 中的 permission 切片变化，将新的权限请求转换为弹窗入队，并在用户响应后调用 SDK `respondPermission()`。

---

## 一、职责

- 监听 TuiStore `permissions` 切片的变化。
- 将新增的 `UiPermissionRequest` 转换为 `DialogRequest`，入队 AppStateContext 弹窗队列。
- 提供 `onRespond` 回调，调用 `client.respondPermission(requestId, response)`。
- 提供 `onCancel` 回调，调用 `client.respondPermission(requestId, { choiceId: deny })`。
- 监听 `permission.resolved` 事件，关闭非通过 UI 响应的请求（如 backend timeout 自动 deny）。

**不做的事**：
- 不直接订阅 backend Bus。
- 不直接调用 backend `Permission.respond()`。
- 不维护独立的 permission 状态（状态在 TuiStore）。

---

## 二、签名

```typescript
function usePermission(client: UiBackendClient): void
```

无返回值。纯副作用 Hook。

权限响应通过弹窗的 `onRespond` 回调传递，不需要从 Hook 返回。

---

## 三、调用位置

**App.tsx**（全局唯一，与 useStream 同级）

```tsx
function App({ client }: { client: UiBackendClient }) {
  useStream(client)
  useCatalog(client)
  usePermission(client)
  useInteraction(client)
  useKeyboard()
  // ...
}
```

---

## 四、事件处理流程

```
SDK event: permission.requested
    │
    ▼
useStream dispatch → TuiStore.permissions append
    │
    ▼
usePermission 检测到 permissions 切片新增条目
    │
    ▼
enqueueDialog({
  source: 'permission',
  request: permissionRequest,
  priority: 'high',
  onRespond: (result) => {
    client.respondPermission(request.id, result)
  },
  onCancel: () => {
    client.respondPermission(request.id, { choiceId: denyChoice.id })
  },
})
    │
    ▼
DialogManager 显示 PermissionDialog
    │
    ▼
用户选择 → onRespond 被调用
    │
    ▼
client.respondPermission() → backend 继续执行
    │
    ▼
SDK event: permission.resolved
    │
    ▼
useStream dispatch → TuiStore.permissions 移除
```

---

## 五、实现要点

```typescript
function usePermission(client: UiBackendClient): void {
  const { enqueueDialog } = useContext(AppActionsContext)
  const permissions = usePermissions()
  const enqueuedRef = useRef(new Set<string>())

  useEffect(() => {
    for (const req of permissions) {
      if (enqueuedRef.current.has(req.id)) continue
      enqueuedRef.current.add(req.id)

      enqueueDialog({
        source: 'permission',
        request: req,
        priority: 'high',
        onRespond: (result) => {
          client.respondPermission(req.id, result as UiPermissionResponse)
        },
        onCancel: () => {
          const denyChoice = req.choices.find(c => c.intent === 'deny')
          if (denyChoice) {
            client.respondPermission(req.id, { choiceId: denyChoice.id })
          }
        },
      })
    }

    for (const id of enqueuedRef.current) {
      if (!permissions.some(p => p.id === id)) {
        enqueuedRef.current.delete(id)
      }
    }
  }, [permissions, enqueueDialog, client])
}
```

- 使用 `enqueuedRef` 防止同一 permission 重复入队。
- `permissions` 来自 TuiStore selector，变化时触发 effect。
- `permission.resolved` 由 useStream 处理（从 TuiStore 移除），本 hook 通过 selector 感知移除。

---

## 六、为什么 usePermission 不返回 currentRequest？

权限请求通过 `enqueueDialog` 进入统一的弹窗队列。当前弹窗状态由 `AppStateContext.dialog.current` 管理。DialogManager 根据 `dialog.current.source` 渲染对应弹窗组件。usePermission 只做"TuiStore → dialog 队列"的桥接。

---

## 七、依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `UiBackendClient` | 参数 | `respondPermission()` |
| `usePermissions` | TuiStore selector | 读取当前 permission 列表 |
| AppActionsContext | 写 | `enqueueDialog()` |

---

## 八、文档自检

- [x] 不直接订阅 backend Bus。
- [x] 通过 TuiStore selector 感知 permission 变化。
- [x] 响应通过 `client.respondPermission()` 回传。
- [x] 防重复入队机制已说明。
- [x] 与 DialogManager 的协作流程完整。
