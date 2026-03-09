# SessionContext 会话状态

本文档定义 SessionContext 的状态结构与消息缓存策略。

SessionContext 管理当前会话的数据，核心是消息列表的高性能缓存机制。采用 useRef + 版本号模式，避免流式响应期间的性能问题。

---

## 一、职责

管理当前会话相关的数据：

- 会话标识和名称
- 消息列表缓存（高性能方案）
- Token 使用统计

---

## 二、State 定义

```typescript
interface SessionContextValue {
  // 会话标识
  sessionId: string | null
  sessionName: string | null

  // 消息缓存（useRef + 版本号模式）
  messagesRef: React.MutableRefObject<MessageWithParts[]>
  messageVersion: number     // 递增计数器，消息数量变化时递增

  // Token 统计
  tokenUsage: {
    currentTokens: number    // 当前 token 数
    contextLimit: number     // 模型 context limit
    usageRatio: number       // 使用率（0-1）
  }

  // Actions
  refreshMessages: () => Promise<void>   // 从 message 模块重新加载消息
  clearMessages: () => void              // 清空消息缓存
}
```

**初始值**：
```typescript
{
  sessionId: null,
  sessionName: null,
  messagesRef: { current: [] },
  messageVersion: 0,
  tokenUsage: { currentTokens: 0, contextLimit: 0, usageRatio: 0 },
}
```

---

## 三、消息缓存策略

### 3.1 问题分析

流式响应期间，`Message.Event.PartUpdated` 事件频率极高（每秒数十次）。传统 React 状态更新模式：

```typescript
// 每次 Part 更新都创建新数组 -> 全量重渲染
setMessages(prev => prev.map(msg =>
  msg.id === targetId
    ? { ...msg, parts: msg.parts.map(p => p.id === partId ? newPart : p) }
    : msg
))
```

这会导致 MessageList 及所有子组件因数组引用变化而全量重渲染。

### 3.2 解决方案

采用 **useRef + 版本号 + Bus 直通** 三层机制：

| 层级 | 机制 | 触发场景 | 性能影响 |
|------|------|---------|---------|
| 第一层 | `messagesRef.current` 直接修改 | 所有消息更新 | 无重渲染 |
| 第二层 | `messageVersion` 递增 | 消息数量变化 | MessageList 重新从 ref 读取 |
| 第三层 | Bus 事件直通 Part 组件 | 流式 Part 增量更新 | 仅对应 Part 组件更新 |

### 3.3 更新流程

```
Bus.publish(Message.Event.PartUpdated, { messageId, partId, delta })
    |
    v
useStream 接收事件
    |
    +-- 更新 messagesRef.current 中对应的 Part（第一层，无重渲染）
    |
    +-- 如果消息数量未变，不递增 messageVersion
    |
    +-- 对应的 TextPart/ToolPart 组件自行订阅 Bus 事件更新显示（第三层）


Bus.publish(Message.Event.Updated, { message })
    |
    v
useStream 接收事件
    |
    +-- 更新 messagesRef.current（第一层）
    |
    +-- messageVersion++（第二层，触发 MessageList 重新读取）
```

### 3.4 消费方式

```typescript
// MessageList 组件
function MessageList() {
  const { messagesRef, messageVersion } = useContext(SessionContext)

  // messageVersion 变化时，从 ref 读取最新消息列表
  const messages = useMemo(() => messagesRef.current, [messageVersion])

  return (
    <VirtualizedList
      items={messages}
      renderItem={(msg) => <HistoryItemDisplay message={msg} />}
    />
  )
}
```

---

## 四、数据来源

| 字段 | 来源 | 更新时机 |
|------|------|---------|
| `sessionId` | session 模块 | 会话创建/切换时 |
| `sessionName` | session 模块 | 会话创建/重命名时 |
| `messagesRef` | message 模块 -> useStream 同步 | 每次 Bus 消息事件 |
| `messageVersion` | useStream 内部递增 | 消息数量变化时 |
| `tokenUsage` | Context.Event.UsageUpdated | lifecycle 每步计算后发布 |

---

## 五、消费者清单

| 消费者 | 读取字段 | 用途 |
|--------|---------|------|
| MessageList | `messagesRef`, `messageVersion` | 渲染消息列表 |
| StatusBar | `sessionName`, `tokenUsage` | 显示会话名和 token 用量 |
| useAutoScroll | `messageVersion` | 新消息到达时触发自动滚动 |
| useStream | `messagesRef`（写入） | 同步 Bus 事件到消息缓存 |
| HomeView | `sessionId` | 判断是否有活跃会话 |

---

## 六、与 message 模块的类型关系

SessionContext 直接引用 message 模块定义的类型，不重新定义：

```typescript
import type {
  Message,
  MessageWithParts,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
} from '@/core/message'
```

---

## 七、Provider 实现要点

```tsx
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const config = useContext(ConfigContext)  // 获取 contextLimit

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState<string | null>(null)
  const messagesRef = useRef<MessageWithParts[]>([])
  const [messageVersion, setMessageVersion] = useState(0)
  const [tokenUsage, setTokenUsage] = useState({
    currentTokens: 0,
    contextLimit: 0,
    usageRatio: 0,
  })

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return
    const messages = await Message.getBySessionId(sessionId)
    messagesRef.current = messages
    setMessageVersion(v => v + 1)
  }, [sessionId])

  const clearMessages = useCallback(() => {
    messagesRef.current = []
    setMessageVersion(v => v + 1)
  }, [])

  const value = useMemo(() => ({
    sessionId,
    sessionName,
    messagesRef,
    messageVersion,
    tokenUsage,
    refreshMessages,
    clearMessages,
  }), [sessionId, sessionName, messageVersion, tokenUsage,
       refreshMessages, clearMessages])

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  )
}
```

**关键**：
- `messagesRef` 不在 useMemo 依赖中（ref 引用不变）
- `messageVersion` 在依赖中，它的变化驱动消费者刷新
- `tokenUsage` 由 Bus 事件 `Context.Event.UsageUpdated` 更新

---

## 八、设计理由

### 为什么不用 React 状态管理消息列表？

流式响应期间 Part 更新频率极高。React 的不可变更新模式会每次创建新数组引用，导致全量 diff 和重渲染。useRef 绕过 React 的渲染周期，仅在必要时（消息数量变化）通过版本号触发重渲染。

### 为什么 tokenUsage 放在 SessionContext 而不是 ConfigContext？

token 使用量是每个会话独立的运行时数据，不是配置信息。它与会话绑定（切换会话时重置），逻辑上属于 SessionContext。

### 为什么 SessionContext 依赖 ConfigContext？

需要 `contextLimit`（模型的最大 context 长度）来计算 `usageRatio`。不同模型的 context limit 不同，此值来自 ConfigContext。

---

## 九、文档自检

- [x] 所有字段有明确的类型定义和初始值
- [x] 消息缓存策略（useRef + 版本号 + Bus 直通）已详细说明
- [x] 更新流程有完整的数据流图
- [x] 消费方式有代码示例
- [x] 消费者清单完整
- [x] 与 message 模块的类型关系已说明
- [x] Provider 实现要点已说明
- [x] 性能方案的设计理由已解释
