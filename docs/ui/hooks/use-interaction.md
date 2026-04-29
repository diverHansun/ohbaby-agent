# useInteraction — 交互弹窗桥接 Hook

本文档定义 useInteraction 的职责和与 DialogManager 的协作方式。

useInteraction 监听 TuiStore 中的 pending interactions 变化，将新的交互请求转换为弹窗入队，并在用户响应后调用 SDK `respondInteraction()`。

---

## 一、职责

- 监听 TuiStore `pending.interactions` 切片的变化。
- 将新增的 `UiInteractionRequest` 转换为 `DialogRequest`，入队 AppStateContext 弹窗队列。
- 提供 `onRespond` 回调，调用 `client.respondInteraction(interactionId, response)`。
- 提供 `onCancel` 回调，调用 `client.respondInteraction(interactionId, { kind: 'cancelled' })`。

**不做的事**：
- 不直接订阅 backend Bus。
- 不决定弹窗的视觉表现（由 DialogManager 按 kind + subject 派发到具体 renderer）。
- 不维护独立的 interaction 状态（状态在 TuiStore）。

---

## 二、签名

```typescript
function useInteraction(client: UiBackendClient): void
```

无返回值。纯副作用 Hook。

---

## 三、调用位置

**App.tsx**（全局唯一，与 useStream/usePermission 同级）

---

## 四、事件处理流程

```
SDK event: interaction.requested
    │
    ▼
useStream dispatch → TuiStore.pending.interactions 写入
    │
    ▼
useInteraction 检测到 pending.interactions 新增条目
    │
    ▼
enqueueDialog({
  source: 'interaction',
  request: interactionRequest,
  priority: 'normal',
  onRespond: (result) => {
    client.respondInteraction(request.interactionId, result)
  },
  onCancel: () => {
    client.respondInteraction(request.interactionId, { kind: 'cancelled' })
  },
})
    │
    ▼
DialogManager 按 kind + subject 渲染对应 dialog
    │
    ▼
用户选择 → onRespond 被调用
    │
    ▼
client.respondInteraction() → backend resume command
    │
    ▼
SDK event: interaction.resolved
    │
    ▼
useStream dispatch → TuiStore.pending.interactions 移除
```

---

## 五、实现要点

```typescript
function useInteraction(client: UiBackendClient): void {
  const { enqueueDialog } = useContext(AppActionsContext)
  const interactions = usePendingInteractions()
  const enqueuedRef = useRef(new Set<string>())

  useEffect(() => {
    for (const [id, req] of interactions) {
      if (enqueuedRef.current.has(id)) continue
      enqueuedRef.current.add(id)

      enqueueDialog({
        source: 'interaction',
        request: req,
        priority: 'normal',
        onRespond: (result) => {
          client.respondInteraction(id, result as UiInteractionResponse)
        },
        onCancel: () => {
          client.respondInteraction(id, { kind: 'cancelled' })
        },
      })
    }

    for (const id of enqueuedRef.current) {
      if (!interactions.has(id)) {
        enqueuedRef.current.delete(id)
      }
    }
  }, [interactions, enqueueDialog, client])
}
```

- 与 usePermission 同构：TuiStore selector 感知变化 → 防重复入队 → dialog 回调调 SDK respond。
- interaction 使用 `priority: 'normal'`（permission 使用 `'high'`），确保权限弹窗优先。

---

## 六、与 usePermission 的对比

| 维度 | usePermission | useInteraction |
|---|---|---|
| 数据来源 | `TuiStore.permissions` | `TuiStore.pending.interactions` |
| dialog source | `'permission'` | `'interaction'` |
| 优先级 | `'high'` | `'normal'` |
| 响应方法 | `client.respondPermission()` | `client.respondInteraction()` |
| 取消语义 | deny（安全决策） | cancelled（用户放弃选择） |

两者可以共享一个内部 `useBridgeToDialog` 工具函数，但模块语义应分开。

---

## 七、依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `UiBackendClient` | 参数 | `respondInteraction()` |
| `usePendingInteractions` | TuiStore selector | 读取当前 interaction 列表 |
| AppActionsContext | 写 | `enqueueDialog()` |

---

## 八、文档自检

- [x] 不直接订阅 backend Bus。
- [x] 通过 TuiStore selector 感知 interaction 变化。
- [x] 响应通过 `client.respondInteraction()` 回传。
- [x] 与 usePermission 的对比表清晰。
- [x] 取消语义（cancelled vs deny）已区分。
