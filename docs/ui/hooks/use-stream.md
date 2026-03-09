# useStream 事件桥梁 Hook

本文档定义 useStream 的职责、订阅事件和 Context 更新规则。

useStream 是纯事件桥梁，订阅 Bus 事件并将数据同步到对应的 Context。不包含任何业务逻辑，不返回任何值。

---

## 一、职责

- 订阅所有 UI 层需要响应的 Bus 事件
- 将事件数据同步到 SessionContext 和 AppStateContext
- 管理订阅生命周期（挂载时订阅，卸载时取消）

**不做的事**：
- 不处理 LLM 调用、工具执行等业务逻辑（由 lifecycle 模块负责）
- 不返回任何状态（状态在 Context 中）
- 不做数据转换或过滤（原样搬运）

---

## 二、签名

```typescript
function useStream(): void
```

无参数，无返回值。在 App.tsx 中调用一次即可。

---

## 三、调用位置

**App.tsx**（全局唯一）

```tsx
function App() {
  useStream()    // 全局事件桥梁
  useKeyboard()  // 全局快捷键

  return (
    <DefaultLayout>
      <Router />
    </DefaultLayout>
  )
}
```

---

## 四、订阅的 Bus 事件

### 4.1 事件 -> Context 映射表

| Bus 事件 | 更新的 Context | 更新内容 |
|----------|---------------|---------|
| `Message.Event.Updated` | SessionContext | 消息新增/删除 -> messagesRef + messageVersion++ |
| `Message.Event.PartUpdated` | SessionContext | Part 增量更新 -> messagesRef（不递增 version） |
| `Lifecycle.Event.Started` | AppStateContext | setLoading({ isActive: true }) |
| `Lifecycle.Event.Completed` | AppStateContext | setLoading({ isActive: false, activeToolName: null }) |
| `Lifecycle.Event.Aborted` | AppStateContext | setLoading({ isActive: false, activeToolName: null }) |
| `ToolScheduler.Event.ExecutionStarted` | AppStateContext | setLoading({ activeToolName: toolName }) |
| `ToolScheduler.Event.ExecutionCompleted` | AppStateContext | setLoading({ activeToolName: null }) |
| `Context.Event.UsageUpdated` | SessionContext | 更新 tokenUsage |
| `Session.Event.Created` | SessionContext | 更新 sessionId, sessionName |
| `Session.Event.Switched` | SessionContext | 更新 sessionId, sessionName, 刷新消息 |

### 4.2 消息更新的三层机制

```
Message.Event.PartUpdated（高频，流式响应期间）
    |
    v
  第一层：更新 messagesRef.current 中对应 Part（无重渲染）
    |
  第三层：Part 组件自行订阅 Bus 事件刷新显示
    |
  不递增 messageVersion（避免 MessageList 全量重渲染）


Message.Event.Updated（低频，消息新增/删除/完成）
    |
    v
  第一层：更新 messagesRef.current
    |
  第二层：messageVersion++（触发 MessageList 从 ref 重新读取）
```

### 4.3 加载状态转换

加载状态由两个独立信号组成（`isActive` + `activeToolName`），由 Bus 事件直接驱动，无需人工状态机：

```
Lifecycle.Event.Started
    → isActive = true

ToolScheduler.Event.ExecutionStarted
    → activeToolName = toolName

ToolScheduler.Event.ExecutionCompleted
    → activeToolName = null（自然回落到 "Thinking..."）

Lifecycle.Event.Completed / Aborted
    → isActive = false, activeToolName = null
```

注意：LLM 流式输出期间不产生独立的 Bus 事件，此时 `isActive` 保持 true、`activeToolName` 为 null，加载指示器显示 "Thinking..."。流式文本内容通过 `Message.Event.PartUpdated` 直达 Part 组件渲染。

---

## 五、实现要点

```typescript
function useStream(): void {
  const { messagesRef } = useContext(SessionContext)
  const { setLoading } = useContext(AppActionsContext)
  // SessionContext 的 messageVersion setter 通过内部机制获取

  useEffect(() => {
    const subscriptions: Array<() => void> = []

    // 消息更新（低频）
    subscriptions.push(
      Bus.subscribe(Message.Event.Updated, (payload) => {
        // 更新 ref + 递增版本号
        updateMessagesRef(messagesRef, payload)
        incrementMessageVersion()
      })
    )

    // Part 增量更新（高频）
    subscriptions.push(
      Bus.subscribe(Message.Event.PartUpdated, (payload) => {
        // 只更新 ref，不递增版本号
        updatePartInRef(messagesRef, payload)
        // 加载状态不在此处更新，由 ToolScheduler 事件独立驱动
      })
    )

    // 生命周期事件
    subscriptions.push(
      Bus.subscribe(Lifecycle.Event.Started, () => {
        setLoading({ isActive: true })
      })
    )

    subscriptions.push(
      Bus.subscribe(Lifecycle.Event.Completed, () => {
        setLoading({ isActive: false, activeToolName: null })
      })
    )

    // 工具执行事件
    subscriptions.push(
      Bus.subscribe(ToolScheduler.Event.ExecutionStarted, ({ toolName }) => {
        setLoading({ activeToolName: toolName })
      })
    )

    subscriptions.push(
      Bus.subscribe(ToolScheduler.Event.ExecutionCompleted, () => {
        setLoading({ activeToolName: null })
      })
    )

    // ... 其他事件订阅

    return () => {
      subscriptions.forEach(unsub => unsub())
    }
  }, [])
}
```

**关键**：
- useEffect 空依赖，挂载时订阅一次，卸载时全部取消
- 消息更新通过 ref 直接修改，避免 React 状态更新
- 加载状态通过 AppActionsContext 的 setLoading 更新

---

## 六、设计理由

### 为什么是纯副作用（无返回值）？

useStream 的消费者不是调用它的组件（App.tsx），而是各个读取 Context 的下游组件。如果 useStream 返回状态，这些状态要么重复 Context 中的数据（冗余），要么需要通过 props 层层传递（prop drilling）。

### 为什么不拆分为多个 hook（useMessageSync, useLoadingSync 等）？

聚合订阅有两个优势：
1. 单一位置管理所有 Bus 订阅的生命周期，不会遗漏取消订阅
2. 某些事件需要同时更新多个 Context（如 PartUpdated 同时更新消息和加载状态），拆分后需要协调

### 为什么 ConfigContext 的更新不在 useStream 中？

ConfigContext 的更新由 Config.Event.Updated 驱动，但这个事件来自 commands 模块（用户执行 slash 命令），不是来自 lifecycle 流程。ConfigProvider 自身订阅这个事件更合理（见 [config-context.md](../contexts/config-context.md)）。

---

## 七、文档自检

- [x] 签名完整（无参数，无返回值）
- [x] 调用位置已明确（App.tsx，全局唯一）
- [x] 订阅的所有 Bus 事件已列举
- [x] 事件到 Context 的映射关系已说明
- [x] 消息三层更新机制已说明
- [x] 加载状态转换已说明
- [x] 实现要点有代码示例
- [x] 纯副作用设计的理由已解释
