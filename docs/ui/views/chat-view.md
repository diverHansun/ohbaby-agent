# ChatView 对话视图

## 一、职责

ChatView 是应用的核心视图，负责渲染对话消息列表。用户与 AI 的交互内容在此展示，包括用户消息、AI 响应、工具调用结果等。

对应职责追溯：goals-duty.md D2（视图管理 - ChatView）、D3（消息渲染）、D4（虚拟化列表）。

## 二、视觉结构

```
+-------------------------------------+
|  You                                |
|  > 帮我重构 auth 模块                |
|                                     |
|  Iris                               |
|  我来帮你重构 auth 模块...            |
|                                     |
|  +- read_file -----------------+    |
|  | [done] src/auth/index.ts    |    |
|  +-----------------------------+    |
|                                     |
|  分析完成，主要问题是...              |
|                                     |
+-------------------------------------+
|  (LoadingIndicator)                 |  -- DefaultLayout 提供
+-------------------------------------+
|  > _                                |  -- DefaultLayout 提供
+-------------------------------------+
|  StatusBar                          |  -- DefaultLayout 提供
+-------------------------------------+
```

ChatView 仅负责消息列表区域。Prompt、StatusBar、LoadingIndicator 由 DefaultLayout 提供。

## 三、内容组成

### 3.1 消息列表（MessageList）

ChatView 的主体是 MessageList 组件，负责渲染所有对话消息。MessageList 采用虚拟化技术，只渲染可见区域的消息，确保长对话场景下的性能。

MessageList 组件属于 `components/message/` 目录，不在 ChatView 内实现。ChatView 负责将 SessionContext 中的消息数据传递给 MessageList。

### 3.2 空消息态（EmptyState）

当消息数量为零时（从 HomeView 刚跳转过来、消息尚未生成的极短暂过渡期），显示简单的占位提示文字。

EmptyState 是轻量的内联展示元素，不读取 Context。在实际使用中几乎不可见，因为 useInput 在 `navigateTo('chat')` 之后立即调用 `lifecycle.execute()`，消息会迅速出现。

## 四、数据驱动

### 4.1 messageVersion 机制

ChatView 通过 `SessionContext.messageVersion` 感知消息数量变化，而非直接监听消息数组引用。

- `messageVersion` 是整数计数器，每次消息数量变化时递增
- ChatView 读取 `messageVersion` 用于判断是否有消息（`=== 0` 则空态）
- MessageList 读取 `messageVersion` 触发列表刷新
- 实际消息数据从 `SessionContext.messagesRef.current` 读取，这是一个 Ref，读取不触发重渲染

### 4.2 流式消息更新

流式响应的增量更新不通过 ChatView 组件链传递。MessageList 内部的 Part 组件通过 Bus 事件（`Message.Event.PartUpdated`）直接接收流式增量，避免中间组件不必要的重渲染。

详见 hooks/use-stream.md 中的"三层消息更新"机制。

## 五、组件组合

| 组件 | 来源 | 数据依赖 |
|------|------|---------|
| MessageList | `components/message/MessageList` | messagesRef, messageVersion |
| EmptyState | ChatView 内联 | 无 |

ChatView 的组件组合极其简单：根据 messageVersion 二选一渲染。

## 六、Context 依赖

| Context | 读取字段 | 用途 |
|---------|---------|------|
| SessionContext | `messagesRef`, `messageVersion` | 消息数据传递和空态判断 |

ChatView 不读取 AppStateContext、ConfigContext、AppActionsContext。不直接订阅 Bus 事件（事件订阅由 useStream hook 和 MessageList 内部组件处理）。

## 七、设计约束

1. **不包含输入逻辑**：输入由 DefaultLayout 中的 Prompt 和 useInput hook 处理
2. **不管理滚动**：自动滚动由 useAutoScroll hook 在 MessageList 层处理
3. **不处理流式更新**：流式增量通过 Bus 事件直达 Part 组件，不经过 ChatView
4. **不负责加载状态**：加载指示器由 DefaultLayout 渲染

## 八、文档自检

- [x] ChatView 的职责可以用一句话说明（渲染消息列表）
- [x] 与 DefaultLayout 的职责边界清晰（不管输入、加载、状态栏）
- [x] messageVersion 驱动机制已说明，避免高频重渲染
- [x] 流式更新路径已说明（Bus 事件直达 Part 组件）
- [x] 组件组合极简，符合单一职责
- [x] Context 依赖最小化
