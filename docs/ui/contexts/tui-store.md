# TuiStore — SDK 数据投影

本文档定义 TuiStore 的职责、形状与更新规则。

TuiStore 是 `ohbaby-tui` 中 SDK 数据的唯一本地投影。所有来自 `UiBackendClient` 的 snapshot、RPC 结果和事件增量，都先写入 TuiStore，再由 selector hooks 暴露给组件。

---

## 一、职责

- 持有 SDK 数据的本地副本（runtime、session、messages、catalog、permissions、pending invocations）。
- 接收 `useStream` dispatch 的 SDK 事件，通过 reducer 更新对应切片。
- 提供 selector hooks 供组件按需订阅切片。
- 处理 `stream.gap` 时的硬重置协议。

**不做的事**：
- 不持有纯 UI 控制状态（view/dialog/loading 归 AppStateContext）。
- 不持有输入设施状态（keypress/mouse 归各自 Context）。
- 不直接调用 `UiBackendClient` 方法（调用由 hooks 负责）。

---

## 二、Store 形状

```typescript
interface TuiStoreState {
  runtime: UiRuntimeState | null
  sessions: readonly UiSessionSummary[]
  activeSessionId: string | null
  messages: readonly UiMessage[]
  runs: readonly UiRun[]
  permissions: readonly UiPermissionRequest[]
  catalog: UiCommandCatalog | null
  catalogInvalidation: CatalogInvalidation | null
  pending: PendingState
}

interface CatalogInvalidation {
  version: string
  reason: string
  receivedAt: number
}

interface PendingState {
  invocations: Map<string, PendingInvocation>
  interactions: Map<string, UiInteractionRequest>
}

interface PendingInvocation {
  clientInvocationId: string
  commandId: string
  startedAt: number
  status: 'submitted' | 'started' | 'completed' | 'failed'
}
```
初始值由 `getSnapshot()` + `listCommands()` 填充。`messages` 初始为空，首屏通过 `getMessages(activeSessionId)` 拉取。

---

## 三、Reducer 事件映射

TuiStore 使用单一 reducer 入口。每个 SDK 事件映射到一个或多个切片更新：

| SDK 事件 | 目标切片 | 更新规则 |
|---|---|---|
| `snapshot.replaced` | runtime/sessions/runs/messages/permissions | 用 backend snapshot 重建持久状态；保留本地 catalog、command notices、interactions、live permissions 与 resolved-permission tombstones |
| `runtime.updated` | `runtime` | 整体替换 |
| `session.updated` | `sessions` | 按 id upsert |
| `message.appended` | `messages` | append 到列表尾部 |
| `message.part.delta` | — | 不走 reducer，走 part-delta emitter（见下文） |
| `run.updated` | `runs` | 按 id upsert |
| `permission.requested` | `permissions` | append |
| `permission.resolved` | `permissions` | 按 id 移除 |
| `command.started` | `pending.invocations` | 状态 → `started` |
| `command.result.delivered` | `pending.invocations` | 状态 → `completed` |
| `command.failed` | `pending.invocations` | 状态 → `failed` |
| `command.catalog.updated` | `catalogInvalidation` | 标记 catalog 失效；由 `useCatalog` 观察后重新调 `listCommands` 写入 `catalog` |
| `interaction.requested` | `pending.interactions` | 按 interactionId 写入 |
| `interaction.resolved` | `pending.interactions` | 按 interactionId 移除 |

---

## 四、Part-Delta Emitter

`message.part.delta` 是高频事件（流式响应期间每秒数十次）。为避免 reducer 全量 dispatch 导致不必要的组件重渲染，TuiStore 内部维护一个 part-delta emitter：

1. `useStream` 收到 `message.part.delta` 时，直接更新 `messages` 数组中对应 part 的内容（原地修改，不触发 selector 通知）。
2. 同时通过 SDK 事件广播 `{ messageId, partId?, delta, content? }`。
3. Text part 优先使用 `content` 作为权威快照；`partId` 仅用于未来稳定定位具体 part。
4. 当 `message.appended` 到达时（消息数量变化），走正常 reducer，触发 MessageList 级别的重渲染。

这延续了原设计中"useRef + 版本号 + Bus 直通"的三层优化思路，只是数据来源从 backend Bus 改为 SDK 事件。

---

## 五、Stream Gap Reconcile

当 `useStream` 收到 `stream.gap` 事件时，TuiStore 进入 reconcile 模式：

1. **暂停**：暂停向 reducer dispatch 后续普通事件。
2. **重建**：
   - 调用 `client.getSnapshot()` → 写入 runtime/sessions/runs/permissions。
   - 调用 `client.listCommands({ surface: 'tui' })` → 写入 catalog。
   - 调用 `client.getMessages(activeSessionId)` → 写入 messages。
3. **合并本地队列**：保留本地 command notices、pending interactions、live permissions 与 resolved-permission tombstones，避免旧 snapshot 复活已处理的权限请求。
4. **保留**：用户正在编辑的 Prompt 文本不受影响（PromptState 归 AppStateContext）。
5. **恢复**：恢复消费后续事件。

---

## 六、与 UI Context 的边界

| 数据 | 归属 | 理由 |
|---|---|---|
| runtime/sessions/messages/catalog/catalogInvalidation/permissions/pending | TuiStore | 来自 SDK，是 backend 状态的投影 |
| view state / dialog queue / loading phase | AppStateContext | 纯 UI 控制状态，不来自 SDK |
| navigateTo / enqueueDialog / setLoading | AppActionsContext | UI 控制动作 |
| keypress / mouse events | KeypressContext / MouseContext | 输入设施 |

TuiStore 不读取任何 UI Context；UI Context 不写入 TuiStore。两者通过 hooks 层间接协作（例如 `useStream` 同时 dispatch 到 TuiStore 和调用 AppActions.setLoading）。

---

## 七、设计模式

### External Store + Selector

TuiStore 采用 `useSyncExternalStore` 模式（React 18+），组件通过 selector 函数订阅切片，只在切片引用变化时重渲染。

**理由**：
- 避免 Context 嵌套过深。
- selector 粒度比 Context 更细，减少不必要的重渲染。
- 与 zustand / jotai 等社区方案的心智模型一致，降低后续迁移成本。

**未使用 zustand/jotai**：V1 不引入额外依赖，用原生 `useSyncExternalStore` 即可满足需求。如果后续 store 逻辑复杂化，可考虑引入。

---

## 八、文档自检

- [x] TuiStore 只持有 SDK 投影数据，不持有 UI 控制状态。
- [x] 每个 SDK 事件都有明确的 reducer 映射。
- [x] part-delta 高频路径有独立优化方案。
- [x] stream.gap reconcile 协议完整。
- [x] 与 UI Context 的边界清晰。
