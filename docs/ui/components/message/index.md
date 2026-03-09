# Message 消息组件概述

## 一、定位

消息组件负责渲染对话中的所有消息内容。采用**类型路由模式**：MessageList 作为虚拟化容器，HistoryItemDisplay 根据消息角色分发到具体的消息组件，每种消息组件内部再按 Part 类型分发到对应的 Part 组件。

对应职责追溯：goals-duty.md D3（消息渲染）、D4（虚拟化列表）、G5（组件化与性能）。

## 二、组件层级

```
MessageList（虚拟化容器，基于 shared/VirtualizedList）
  └── HistoryItemDisplay（类型路由器，按 message.role 分发）
        ├── UserMessage           # role: 'user'
        ├── AssistantMessage      # role: 'assistant'
        │     └── 遍历 parts[] 渲染：
        │           ├── TextPart
        │           ├── ReasoningPart
        │           ├── ToolPart
        │           └── FilePart
        └── SystemMessage         # role: 'system'（按 kind 分发）
              ├── kind: 'abort'   → 中断提示
              ├── kind: 'error'   → 错误提示
              └── kind: 'info'    → 信息提示
```

## 三、组件文档

| 组件 | 文档 | 职责 |
|------|------|------|
| MessageList | [message-list.md](./message-list.md) | 虚拟化容器，管理滚动和可见区域 |
| Part 组件 | [parts/](./parts/index.md) | 各类 Part 的具体渲染 |

HistoryItemDisplay、UserMessage、AssistantMessage、SystemMessage 为消息层组件，逻辑简单（纯路由或简单包装），不单独建文档。

## 四、类型路由模式

### 4.1 为什么选择类型路由

每种消息类型的渲染逻辑差异较大：
- UserMessage 只显示用户输入文本
- AssistantMessage 需要遍历多种 Part 类型
- SystemMessage 按 kind 字段进一步分发

将它们拆分为独立组件，而非用 if/else 堆在一起，使每个组件的职责清晰、可独立测试、新增消息类型时只需添加组件。

### 4.2 路由规则

HistoryItemDisplay 根据 `MessageWithParts.info.role` 分发：

| role | 组件 | 说明 |
|------|------|------|
| `user` | UserMessage | 渲染用户输入文本 |
| `assistant` | AssistantMessage | 遍历 parts，按 Part 类型渲染 |
| `system` | SystemMessage | 按 kind 字段渲染不同样式的系统提示 |

### 4.3 Part 路由规则

AssistantMessage 遍历 `parts[]` 数组，按 `part.type` 分发：

| part.type | 组件 | 说明 |
|-----------|------|------|
| `text` | TextPart | Markdown 文本渲染 |
| `reasoning` | ReasoningPart | 推理过程，默认折叠 |
| `tool` | ToolPart | 工具调用状态和结果 |
| `file` | FilePart | 文件附件链接 |
| `step-start` | 不渲染 | Step 边界标记，UI 跳过 |
| `step-finish` | 不渲染 | Step 边界标记，UI 跳过 |
| `subtask` | 不渲染 | MVP 不实现，预留 |

## 五、数据流

### 5.1 消息数据来源

消息数据从 `SessionContext.messagesRef.current` 获取，类型为 `MessageWithParts[]`。每个 `MessageWithParts` 包含：
- `info: Message` -- 消息元数据（role、time、tokens 等）
- `parts: Part[]` -- 消息内容片段列表

### 5.2 更新机制

消息组件的更新通过三层机制实现（详见 hooks/use-stream.md）：

1. **第一层**：`messagesRef.current` 直接修改（不触发重渲染）
2. **第二层**：`messageVersion++` 递增（触发 MessageList 从 ref 重新读取）
3. **第三层**：`Message.Event.PartUpdated` Bus 事件直达 Part 组件（流式增量更新）

Part 组件可自行订阅 Bus 事件接收增量更新，避免中间组件（MessageList → HistoryItemDisplay → AssistantMessage）不必要的重渲染链。

## 六、视觉示例

```
You                                        ← UserMessage
> 帮我重构 auth 模块

Iris                                       ← AssistantMessage
我来帮你重构 auth 模块。首先看一下现有代码...    ← TextPart

  [done] read_file                         ← ToolPart（completed 状态）
  [result] src/auth/index.ts (142 lines)

分析完成，主要问题是...                       ← TextPart（第二段）

--- System: execution aborted ---          ← SystemMessage（kind: abort）
```

## 七、设计原则

1. **类型路由，不用 if/else**：每种消息类型和 Part 类型独立组件
2. **Part 自治更新**：Part 组件可直接订阅 Bus 事件，不依赖父组件 props 传递
3. **跳过不可见 Part**：StepStartPart、StepFinishPart、SubtaskPart 在路由中直接跳过
4. **消息组件无业务逻辑**：只负责渲染，不调用 lifecycle、commands 等模块

## 八、文档自检

- [x] 类型路由模式的理由清晰
- [x] 组件层级完整，路由规则明确
- [x] Part 类型覆盖 message 模块定义的所有 7 种 Part
- [x] 不渲染的 Part 类型已明确标注
- [x] 三层更新机制已引用
- [x] 数据来源和类型已说明（MessageWithParts）
