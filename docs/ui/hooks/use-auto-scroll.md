# useAutoScroll — 自动滚动 Hook

本文档定义 useAutoScroll 的职责、接口和滚动控制逻辑。

useAutoScroll 控制消息列表的自动滚动行为：新消息到达时自动滚动到底部，用户手动滚动时暂停自动滚动。

---

## 一、职责

- 监听消息列表的新增事件，自动滚动到底部。
- 检测用户手动滚动，暂停自动滚动。
- 检测用户滚动回底部，恢复自动滚动。

---

## 二、签名

```typescript
function useAutoScroll(options: {
  messageCount: number
}): {
  scrollToBottom: () => void
  isAutoScrolling: boolean
  onUserScroll: (scrollTop: number, scrollHeight: number, clientHeight: number) => void
}
```

**参数**：
- `messageCount`：消息数量（来自 `useMessages()`），变化时触发自动滚动。

---

## 三、调用位置

**MessageList 组件**（唯一调用位置）

```tsx
function MessageList() {
  const messages = useMessages()
  const { scrollToBottom, isAutoScrolling, onUserScroll } = useAutoScroll({
    messageCount: messages.length,
  })

  return <ScrollableList onScroll={onUserScroll} />
}
```

---

## 四、自动滚动逻辑

- 初始状态：`isAutoScrolling = true`。
- `messageCount` 增加时：如果 `isAutoScrolling` 为 true，则执行 `scrollToBottom()`。
- 用户向上滚动：`isAutoScrolling = false`。
- 用户滚动回底部附近：`isAutoScrolling = true`。

通过消息数量而不是完整消息数组引用触发，避免 `message.part.delta` 高频更新时频繁滚动。只在新消息到达（`message.appended`）时滚动。

---

## 五、文档自检

- [x] 触发源从 SessionContext.messageVersion 改为 `messageCount`。
- [x] 不依赖已删除的 SessionContext。
- [x] 仍然只在新消息到达时自动滚动。
