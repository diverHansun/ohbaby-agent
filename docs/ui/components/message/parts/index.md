# Parts 消息内容组件概述

## 一、定位

Part 组件负责渲染消息的具体内容片段。一条 AssistantMessage 可以包含多个 Part，按顺序排列。每种 Part 类型有独立的渲染组件。

Part 组件是消息渲染的最底层，直接面向用户呈现文本、工具调用、推理过程等内容。

## 二、Part 类型与组件映射

| Part 类型 | 组件 | 文档 | 是否渲染 |
|-----------|------|------|---------|
| `text` | TextPart | [text-part.md](./text-part.md) | 渲染 |
| `reasoning` | ReasoningPart | [reasoning-part.md](./reasoning-part.md) | 渲染 |
| `tool` | ToolPart | [tool-part.md](./tool-part.md) | 渲染 |
| `file` | FilePart | [file-part.md](./file-part.md) | 渲染 |
| `step-start` | -- | -- | 不渲染（内部边界标记） |
| `step-finish` | -- | -- | 不渲染（内部边界标记） |
| `subtask` | -- | -- | 不渲染（MVP 预留） |

## 三、渲染顺序

AssistantMessage 按 `parts[]` 数组的顺序依次渲染 Part 组件。一条典型的 AI 响应的 Part 序列：

```
parts[0]: StepStartPart     → 跳过
parts[1]: TextPart           → 渲染（"我来帮你分析..."）
parts[2]: ToolPart           → 渲染（read_file 调用）
parts[3]: TextPart           → 渲染（"分析结果是..."）
parts[4]: ToolPart           → 渲染（edit_file 调用）
parts[5]: TextPart           → 渲染（"修改完成..."）
parts[6]: StepFinishPart     → 跳过
```

## 四、流式更新机制

Part 组件是流式更新的终端接收者。TextPart 和 ToolPart 可以自行订阅 `Message.Event.PartUpdated` Bus 事件，直接接收增量数据：

- **TextPart**：事件 payload 包含 `delta` 字段（增量文本），追加到已有内容后重新渲染
- **ToolPart**：事件 payload 包含 `state` 变化，更新工具执行状态

这种 "Bus 事件直达 Part 组件" 的设计避免了中间组件（MessageList → HistoryItemDisplay → AssistantMessage）的不必要重渲染。

## 五、Part 共享属性

所有 Part 共享以下基础字段（来自 message 模块 data-model）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | Part 唯一标识 |
| messageId | string | 所属消息 ID |
| sessionId | string | 所属会话 ID |

Part 组件通过 `id` 字段匹配 Bus 事件中的 Part 更新。

## 六、设计原则

1. **Part 自治**：每个 Part 组件独立管理自己的渲染和更新，不依赖父组件 props 驱动更新
2. **类型独立**：每种 Part 类型一个组件文件，不混合
3. **跳过不可见**：StepStartPart、StepFinishPart、SubtaskPart 在 AssistantMessage 的渲染循环中直接跳过
4. **无业务逻辑**：Part 组件只负责渲染，不调用外部模块的业务接口

## 七、文档自检

- [x] 覆盖 message 模块定义的全部 7 种 Part 类型
- [x] 渲染/不渲染的 Part 类型已明确标注
- [x] 流式更新机制已说明（Bus 事件直达 Part）
- [x] 共享属性已列出
- [x] 渲染顺序示例清晰
