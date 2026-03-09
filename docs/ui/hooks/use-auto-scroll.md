# useAutoScroll 自动滚动 Hook

本文档定义 useAutoScroll 的职责、接口和滚动控制逻辑。

useAutoScroll 控制消息列表的自动滚动行为：新消息到达时自动滚动到底部，用户手动滚动时暂停自动滚动。

---

## 一、职责

- 监听消息版本号变化，自动滚动到底部
- 检测用户手动滚动，暂停自动滚动
- 检测用户滚动回底部，恢复自动滚动

---

## 二、签名

```typescript
function useAutoScroll(options: {
  messageVersion: number
}): {
  scrollToBottom: () => void
  isAutoScrolling: boolean
  onUserScroll: (scrollTop: number, scrollHeight: number, clientHeight: number) => void
}
```

**参数**：
- `messageVersion`：消息版本号（来自 SessionContext），变化时触发自动滚动

**返回值**：
- `scrollToBottom`：手动滚动到底部
- `isAutoScrolling`：当前是否处于自动滚动模式
- `onUserScroll`：用户滚动回调（传入滚动位置信息）

---

## 三、调用位置

**MessageList 组件**（唯一调用位置）

```tsx
function MessageList() {
  const { messageVersion } = useContext(SessionContext)
  const { scrollToBottom, isAutoScrolling, onUserScroll } = useAutoScroll({ messageVersion })

  return (
    <ScrollableList
      onScroll={onUserScroll}
      // ...
    />
  )
}
```

---

## 四、自动滚动逻辑

### 4.1 状态模型

```typescript
isAutoScrolling: boolean    // 默认 true
```

### 4.2 状态转换

```
初始状态: isAutoScrolling = true
    |
    +-- messageVersion 变化 -> 如果 isAutoScrolling，执行 scrollToBottom
    |
    +-- 用户手动向上滚动 -> isAutoScrolling = false（暂停）
    |
    +-- 用户滚动到底部附近（阈值内）-> isAutoScrolling = true（恢复）
    |
    +-- 调用 scrollToBottom() -> isAutoScrolling = true（恢复）
```

### 4.3 底部检测

判断用户是否滚动到底部附近：

```typescript
const SCROLL_THRESHOLD = 50  // 距底部 50 像素以内视为"在底部"

function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD
}
```

### 4.4 onUserScroll 回调

```typescript
function onUserScroll(scrollTop: number, scrollHeight: number, clientHeight: number): void {
  if (isNearBottom(scrollTop, scrollHeight, clientHeight)) {
    // 用户滚动到底部 -> 恢复自动滚动
    setIsAutoScrolling(true)
  } else {
    // 用户向上滚动 -> 暂停自动滚动
    setIsAutoScrolling(false)
  }
}
```

---

## 五、与 messageVersion 的协作

```
useStream 更新消息 -> messageVersion++
                          |
                          v
                useAutoScroll 检测到 version 变化
                          |
                    isAutoScrolling?
                    /           \
                  是              否
                  |               |
            scrollToBottom()    不操作
```

通过 messageVersion 而非消息数组引用触发，避免流式 Part 更新时频繁滚动。只在消息数量变化（新消息到达）时滚动。

---

## 六、依赖关系

| 依赖 | 类型 | 用途 |
|------|------|------|
| SessionContext | 读 | 获取 messageVersion |
| ScrollableList | 协作 | 接收 onUserScroll 回调，调用其滚动 API |

---

## 七、文档自检

- [x] 签名完整（参数 + 返回值）
- [x] 调用位置已明确（MessageList，唯一）
- [x] 自动滚动逻辑有状态转换图
- [x] 底部检测阈值已说明
- [x] 与 messageVersion 的协作关系已说明
- [x] 暂停/恢复机制已说明
