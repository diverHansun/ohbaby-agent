# useStream — SDK 事件聚合订阅器

本文档定义 useStream 的职责、订阅事件和 TuiStore 更新规则。

useStream 是 SDK 事件到 TuiStore 的唯一管道。它订阅 `client.subscribeEvents()`，将每个 SDK 事件 dispatch 到 TuiStore reducer，并在必要时调用 AppActions 更新 UI 控制状态。

---

## 一、职责

- 订阅 `UiBackendClient.subscribeEvents()` 的事件流。
- 将 SDK 事件 dispatch 到 TuiStore reducer 更新对应切片。
- 将 `message.part.delta` 路由到 TuiStore 的 part-delta emitter（不走 reducer）。
- 根据 `run.updated` 事件派生 LoadingState，调用 `AppActions.setLoading()`。
- 处理 `stream.gap` 事件，执行 reconcile 协议。

**不做的事**：
- 不调用 `UiBackendClient` 的写方法（submitPrompt/executeCommand/respond* 由其他 hooks 负责）。
- 不处理 dialog 入队（permission/interaction 入队由 usePermission/useInteraction 负责）。
- 不处理 catalog 刷新（由 useCatalog 负责）。

---

## 二、签名

```typescript
function useStream(client: UiBackendClient): void
```

无返回值。在 App.tsx 中调用一次。

---

## 三、调用位置

**App.tsx**（全局唯一）

```tsx
function App({ client }: { client: UiBackendClient }) {
  useStream(client)
  useCatalog(client)
  useKeyboard()

  return (
    <DefaultLayout>
      <Router />
    </DefaultLayout>
  )
}
```

---

## 四、SDK 事件 → TuiStore 映射

### 4.1 正常事件 dispatch

| SDK 事件 | TuiStore 操作 | 附带 UI 副作用 |
|---|---|---|
| `snapshot.replaced` | 硬重置全部切片 | `setLoading({ phase: 'idle' })` |
| `runtime.updated` | 替换 `runtime` 切片 | — |
| `session.updated` | upsert `sessions` 切片 | — |
| `message.appended` | append 到 `messages` | — |
| `message.part.delta` | 不走 reducer，走 part-delta emitter | — |
| `run.updated` | upsert `runs` 切片 | 派生 loading（见 4.2） |
| `permission.requested` | append 到 `permissions` | — |
| `permission.resolved` | 从 `permissions` 移除 | — |
| `command.started` | `pending.invocations` 状态 → `started` | — |
| `command.result.delivered` | `pending.invocations` 状态 → `completed` | — |
| `command.failed` | `pending.invocations` 状态 → `failed` | — |
| `command.catalog.updated` | `catalogInvalidation` | 标记 catalog 失效；不调用 `listCommands` |
| `interaction.requested` | 写入 `pending.interactions` | — |
| `interaction.resolved` | 从 `pending.interactions` 移除 | — |

### 4.2 Loading 状态派生

useStream 根据 `run.updated` 事件派生 LoadingState，调用 `AppActions.setLoading()`：

```
run.updated(status.kind === 'running')
  → setLoading({ phase: 'thinking' })

run.updated(status.kind === 'running' 且含 tool execution 信息)
  → setLoading({ phase: 'executing', toolName })

message.part.delta 到达（隐含 streaming）
  → setLoading({ phase: 'streaming' })

run.updated(status.kind === 'idle' | 'error')
  → setLoading({ phase: 'idle' })
```

Loading 状态不由 useInput 主动设置。useInput 提交 prompt/command 后，等待 SDK 事件回流再更新 loading。

### 4.3 Part-Delta 高频路径

`message.part.delta` 不走 reducer，而是：

1. 原地更新 TuiStore `messages` 数组中对应 part 的内容。
2. 通过 SDK/TuiStore 事件广播 `{ messageId, partId?, delta, content? }`。
3. MVP 以 `content` 为权威快照更新最后一个 text/reasoning part，暂不依赖 index 定位。

这延续了原设计的三层优化思路，避免流式响应期间 MessageList 全量重渲染。

---

## 五、Stream Gap Reconcile

当收到 `stream.gap` 事件时，useStream 执行以下协议：

```
1. 暂停：停止向 TuiStore dispatch 后续普通事件。
2. 重建：
   - await client.getSnapshot()     → 写入 runtime/sessions/runs/permissions
   - await client.listCommands()    → 写入 catalog
   - await client.getMessages(sid)  → 写入 messages
3. 清理：清空 pending.invocations 和 pending.interactions。
4. 保留：用户正在编辑的 Prompt 文本不受影响。
5. 恢复：继续消费后续事件。
```

Gap reconcile 是 TuiStore 的"硬重置入口"，与 `snapshot.replaced` 类似但额外拉取 catalog 和 messages。

---

## 六、实现要点

```typescript
function useStream(client: UiBackendClient): void {
  const { setLoading } = useContext(AppActionsContext)

  useEffect(() => {
    const unsub = client.subscribeEvents(async (event) => {
      if (event.type === 'stream.gap') {
        await reconcile(client)
        return
      }

      if (event.type === 'message.part.delta') {
        tuiStore.applyPartDelta(event)
        return
      }

      tuiStore.dispatch(event)

      if (event.type === 'run.updated') {
        deriveLoading(event, setLoading)
      }
    })

    return unsub
  }, [client, setLoading])
}
```

- `useEffect` 依赖 `client` 和 `setLoading`（两者引用稳定）。
- `tuiStore.dispatch` 是同步的 reducer 调用。
- `reconcile` 是异步的，期间暂停普通 dispatch。

---

## 七、与其他 Hook 的关系

| Hook | 关系 |
|---|---|
| useCatalog | useStream 标记 `catalogInvalidation`，useCatalog 观察后调用 `listCommands` |
| usePermission | useStream 把 `permission.requested` 写入 TuiStore；usePermission 从 TuiStore 读取并入队 dialog |
| useInteraction | 同上，处理 `interaction.requested` |
| useInput | useStream 不被 useInput 调用；useInput 触发的 submitPrompt/executeCommand 的结果通过 SDK 事件回流到 useStream |

---

## 八、设计理由

### 为什么是单一聚合订阅器？

1. 单一位置管理 SDK 事件订阅的生命周期，不会遗漏取消订阅。
2. 某些事件需要同时更新 TuiStore 和 UI 控制状态（如 `run.updated` → store + loading），聚合处理避免协调问题。
3. 与原设计的 useStream 角色一致，降低迁移认知成本。

### 为什么 useStream 不直接刷新 catalog？

Catalog 刷新需要调用 `client.listCommands()`（异步 RPC），不适合在 reducer dispatch 路径中执行。useStream 只负责把 `command.catalog.updated` 投影成 TuiStore 的 `catalogInvalidation` 信号；useCatalog 独立管理 catalog 的初始化和刷新生命周期。

---

## 九、文档自检

- [x] 订阅来源是单一的 `client.subscribeEvents()`，不订阅 backend Bus。
- [x] 每个 SDK 事件都有明确的 dispatch 目标。
- [x] part-delta 高频路径有独立优化方案。
- [x] stream.gap reconcile 协议完整。
- [x] loading 状态由 SDK 事件派生，不由 useInput 主动设置。
- [x] 与 useCatalog/usePermission/useInteraction 的分工清晰。
