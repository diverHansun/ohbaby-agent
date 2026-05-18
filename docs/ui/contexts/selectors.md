# Selector Hooks — TuiStore 消费接口

本文档定义 TuiStore 对外暴露的 selector hooks。

组件不直接读取 TuiStore 内部状态，而是通过 selector hooks 订阅所需切片。每个 hook 基于 `useSyncExternalStore` + selector 函数实现，只在切片引用变化时触发重渲染。

---

## 一、Selector 列表

### useRuntime

```typescript
function useRuntime(): UiRuntimeState | null
```

返回 `TuiStore.runtime` 切片。包含 model、mode、agentState、workingDirectory、context token 用量、activeSession 信息。

**典型消费者**：StatusBar、ModelDialog（只做 current 标记）。

---

### useSessionSummaries

```typescript
function useSessionSummaries(): readonly UiSessionSummary[]
```

返回 `TuiStore.sessions` 切片。用于会话列表展示。

**典型消费者**：SessionDialog（interaction subject='session' 的 renderer）。

---

### useActiveSessionId

```typescript
function useActiveSessionId(): string | null
```

返回 `TuiStore.activeSessionId` 切片。用于标记当前会话、切换会话 selector 的 current 项，以及需要知道当前会话身份但不需要读取完整 runtime 的组件。

**典型消费者**：SessionDialog、useInput。

---

### useMessages

```typescript
function useMessages(): readonly UiMessage[]
```

返回 `TuiStore.messages` 切片。当 `message.appended` 到达时引用变化，触发 MessageList 重渲染。

**典型消费者**：MessageList、ChatView。

**注意**：流式 part delta 不通过本 hook 触发。Part 组件使用 `usePartDelta` 订阅增量。

---

### usePartDelta

```typescript
function usePartDelta(
  messageId: string,
  partId?: string,
  handler: (delta: string) => void
): void
```

订阅 TuiStore 内部的 part-delta emitter。仅对应的 Part 组件调用，避免 MessageList 级别重渲染。

**典型消费者**：TextPart、ReasoningPart。

---

### useCommandCatalog

```typescript
function useCommandCatalog(): UiCommandCatalog | null
```

返回 `TuiStore.catalog` 切片。由 `useCatalog` hook（hooks/use-catalog.md）负责初始化和刷新。

**典型消费者**：useInput（补全和 resolve）、HelpView。

---

### useCatalogInvalidation

```typescript
function useCatalogInvalidation(): CatalogInvalidation | null
```

返回最近一次 `command.catalog.updated` 投影出的失效信号。该 hook 属于内部桥接接口，主要由 hooks/use-catalog.md 使用，普通组件不直接消费。

**典型消费者**：useCatalog。

---

### usePendingInvocations

```typescript
function usePendingInvocations(): ReadonlyMap<string, PendingInvocation>
```

返回 `TuiStore.pending.invocations` 切片。用于判断是否有命令正在执行。

**典型消费者**：useStream（派生 loading 状态）、Prompt（显示执行中提示）。

---

### usePermissions

```typescript
function usePermissions(): readonly UiPermissionRequest[]
```

返回 `TuiStore.permissions` 切片。

**典型消费者**：usePermission hook（桥接到 dialog 队列）。

---

### useRuns

```typescript
function useRuns(): readonly UiRun[]
```

返回 `TuiStore.runs` 切片。

**典型消费者**：useStream（派生 loading phase）。

---

## 二、设计原则

### Selector 粒度

每个 selector 返回 store 的一个顶层切片。不提供跨切片的组合 selector（如"当前会话的消息"），组合逻辑由消费组件或 hook 内部完成。

**理由**：跨切片 selector 的引用稳定性难以保证，容易导致意外重渲染。保持 selector 简单，把组合推到消费侧。

### 与 Context 的分工

| 需要的数据 | 用什么 |
|---|---|
| SDK 投影数据（runtime/messages/catalog/...） | TuiStore selector hook |
| UI 控制状态（view/dialog/loading） | AppStateContext |
| UI 控制动作（navigateTo/enqueueDialog） | AppActionsContext |
| 键盘/鼠标事件 | KeypressContext / MouseContext |

---

## 三、文档自检

- [x] 每个 selector 有签名、返回值说明和典型消费者。
- [x] part-delta 有独立的订阅 hook，不走 selector。
- [x] 不提供跨切片组合 selector；`useActiveSessionId` 是顶层切片读取，不组合其他数据。
- [x] 与 UI Context 的分工表清晰。
