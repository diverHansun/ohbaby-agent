# MessageList 消息列表

## 一、职责

MessageList 是消息渲染的入口容器。它基于 `shared/VirtualizedList` 实现虚拟化渲染，只渲染终端可见区域内的消息，确保长对话场景下的性能。

对应职责追溯：goals-duty.md D4（虚拟化列表）。

## 二、数据输入

| 属性 | 类型 | 来源 | 说明 |
|------|------|------|------|
| messagesRef | `React.MutableRefObject<MessageWithParts[]>` | SessionContext | 消息数据引用，读取 `.current` |
| messageVersion | `number` | SessionContext | 消息数量变化计数器，变化时触发列表刷新 |

MessageList 通过 `messageVersion` 感知"消息数量是否发生变化"。`messageVersion` 变化时，从 `messagesRef.current` 重新读取消息列表并更新虚拟化视口。

流式文本增量更新不经过 MessageList，而是由 Part 组件自行订阅 Bus 事件直接刷新。

## 三、虚拟化策略

### 3.1 基于 VirtualizedList

MessageList 基于 `shared/VirtualizedList` 封装，提供消息场景的专用配置：

- `items` -- 从 `messagesRef.current` 读取
- `renderItem` -- 渲染 HistoryItemDisplay（类型路由器）
- `estimatedItemHeight` -- 内容感知的高度估算函数
- `height` -- 来自 DefaultLayout 内容区的可用高度

### 3.2 高度估算（内容感知）

根据消息类型和内容动态计算估算高度：

| 消息类型 | 估算规则 |
|---------|---------|
| UserMessage | 头部 1 行 + `ceil(textLength / terminalWidth)` |
| AssistantMessage | 头部 1 行 + 各 Part 高度之和 |
| SystemMessage | 固定 1-2 行 |

各 Part 的高度估算：

| Part 类型 | 估算规则 |
|-----------|---------|
| TextPart | `ceil(textLength / terminalWidth)`，代码块按行数计算 |
| ToolPart | 固定 2 行（工具名 + 结果摘要） |
| ReasoningPart | 折叠态固定 1 行，展开态按文本长度计算 |
| FilePart | 固定 1 行 |

估算不追求像素级精确，目的是让虚拟化视口的可见范围大致正确，减少空白闪烁。

### 3.3 Overscan

视口上下各多渲染 2-3 个消息项（overscan），减少快速滚动时的白屏。

## 四、自动滚动

MessageList 集成 useAutoScroll hook 的逻辑：

- `messageVersion` 变化时，如果 `isAutoScrolling` 为 true，自动滚动到底部
- 用户手动向上滚动超过阈值（SCROLL_THRESHOLD = 50px）时，`isAutoScrolling` 设为 false
- 用户滚动到底部时，`isAutoScrolling` 恢复为 true

## 五、HistoryItemDisplay（类型路由器）

HistoryItemDisplay 是 MessageList 的 `renderItem` 回调渲染的组件，职责是根据 `message.info.role` 分发到具体的消息组件。

路由规则：

| `info.role` | 渲染组件 |
|-------------|---------|
| `user` | UserMessage |
| `assistant` | AssistantMessage |
| `system` | SystemMessage |

HistoryItemDisplay 是纯路由组件，不包含渲染逻辑。

## 六、消息组件

### 6.1 UserMessage

显示用户输入内容：
- 头部："You"（或用户标识）
- 正文：用户输入的文本（从 parts 中找 TextPart 渲染）

### 6.2 AssistantMessage

显示 AI 响应内容：
- 头部："Iris"（或 AI 标识）
- 正文：遍历 `parts[]` 数组，按 Part 类型路由到对应的 Part 组件
- 跳过 `step-start`、`step-finish`、`subtask` 类型的 Part

### 6.3 SystemMessage

显示系统事件：
- 根据 `info.kind` 使用不同颜色和前缀
- `abort`：灰色，显示"execution aborted"
- `error`：红色，显示错误信息
- `info`：蓝色，显示信息文本

## 七、设计约束

1. **不直接订阅 Bus 事件**：MessageList 通过 `messageVersion` 被动刷新，不主动订阅 Bus
2. **不持有消息数据**：消息数据始终从 `messagesRef.current` 读取，MessageList 不复制数据
3. **不负责流式更新**：流式增量由 Part 组件自行订阅，不经过 MessageList 传递
4. **不负责输入处理**：滚动操作通过 useAutoScroll hook 和鼠标滚轮事件处理

## 八、文档自检

- [x] 虚拟化策略清晰（基于 VirtualizedList、内容感知高度估算）
- [x] 数据输入和刷新机制已说明（messagesRef + messageVersion）
- [x] 自动滚动行为已说明
- [x] 类型路由分发规则完整
- [x] 三种消息组件的渲染内容已概述
- [x] 不直接订阅 Bus 的约束已明确
