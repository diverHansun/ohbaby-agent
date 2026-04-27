# message 模块 goals-duty.md

本文档定义 `message` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：message 模块负责管理对话消息的类型定义、创建、存储和查询，是 ohbaby-agent 中消息内容管理的核心模块。

**如果没有这个模块**：
- lifecycle 无法将 LLM 响应和工具结果持久化
- 用户重新打开会话后无法恢复之前的对话内容
- 消息格式不统一，各模块自行定义导致混乱
- 流式响应无法实时保存，进程崩溃后数据丢失

---

## 二、Design Goals（设计目标）

### G1: 统一消息模型

定义一套完整且统一的消息类型系统，包括 Message 和 Part，供整个应用使用。消息格式对齐 opencode 的成熟实践，确保扩展性和兼容性。

### G2: 实时持久化

消息和 Part 的每次更新都立即写入 Storage，确保进程崩溃后可恢复。不维护内存缓存，每次查询从 Storage 读取最新数据。

### G3: 简单可靠

消息操作接口应直观易用，API 数量保持最小化。遵循 KISS 原则，避免过度设计。

### G4: 支持流式更新

支持 LLM 流式响应场景下的增量更新，Part 可以独立创建和更新，不影响其他 Part。

### G5: 事件驱动

每次消息或 Part 更新后，通过 Bus 广播事件，支持 UI 层实时感知消息变化。

### G6: 格式转换能力

提供将内部消息格式转换为 LLM SDK 所需格式的工具函数，支持多种 LLM 提供商。

---

## 三、Duties（职责）

### D1: 消息类型定义

定义消息相关的核心类型：
- `UserMessage`：用户消息
- `AssistantMessage`：助手消息
- `SystemMessage`：系统消息（用于记录系统事件，如用户中断）
- `Message`：联合类型
- 各种 `Part` 类型：TextPart, ToolPart, ReasoningPart 等

### D2: Part 类型定义

定义消息内容的组成部分（Part）：
- `TextPart`：文本内容
- `ToolPart`：工具调用及结果
- `ReasoningPart`：推理/思考内容
- `FilePart`：文件附件
- `StepStartPart`：Step 开始标记
- `StepFinishPart`：Step 结束标记（含 token/cost 统计）
- `SnapshotPart`：文件系统快照（预留）
- `PatchPart`：文件变更记录（预留）
- `CompactionPart`：上下文压缩标记（预留）
- `SubtaskPart`：子任务标记（预留）
- `AgentPart`：Agent 引用标记（预留）
- `RetryPart`：重试标记（预留）

### D3: 消息 CRUD 操作

提供消息的增删改查操作：
- `updateMessage()`：创建或更新消息
- `updatePart()`：创建或更新 Part
- `getMessages()`：获取会话的消息列表（含 Part）
- `getMessage()`：获取单条消息（含 Part）
- `getParts()`：获取消息的所有 Part
- `removeMessage()`：删除消息及其 Part
- `removeMessages(sessionId)`：删除会话的所有消息（供 Session 模块调用）
- `removePart()`：删除单个 Part

### D4: 消息格式转换

提供消息格式转换工具函数：
- `toModelMessages()`：将内部消息格式转换为 LLM SDK 格式
- 支持过滤无效消息（curated history）

### D5: 消息 ID 生成

提供消息和 Part 的 ID 生成函数：
- `generateMessageId()`：生成消息 ID
- `generatePartId()`：生成 Part ID
- 格式：`message_<timestamp>_<random>`、`part_<timestamp>_<random>`

### D6: 事件广播

消息或 Part 更新后通过 Bus 广播事件：
- `Message.Event.Updated`：消息更新事件
- `Message.Event.Removed`：消息删除事件
- `Message.Event.PartUpdated`：Part 更新事件
- `Message.Event.PartRemoved`：Part 删除事件

---

## 四、Non-Duties（非职责）

### N1: 不负责系统提示词管理

系统提示词的构建和管理由 `system-prompts` 模块负责。message 模块只存储用户和助手消息。

### N2: 不负责 LLM 调用

LLM API 调用、流式响应解析由 `llm-client` 模块负责。message 模块只负责存储 LLM 返回的内容。

### N3: 不负责执行循环协调

对话的执行流程由 `lifecycle` 模块负责。message 模块只提供消息存取接口。

### N4: 不负责会话元数据管理

会话的创建、列表、元数据维护由 `session` 模块负责。message 模块只管理消息内容。

### N5: 不维护内存中的消息缓存

每次查询都从 Storage 读取，不在内存中缓存消息列表。这确保了数据一致性，简化了状态管理。

### N6: 不负责 Token 估算

Token 的估算和统计由 `tokenCounting` 模块负责。message 模块只存储 LLM 返回的实际 token 使用量。

### N7: 不负责工具执行

工具的发现、验证、执行由 `tool-scheduler` 模块负责。message 模块只存储工具调用请求和结果。

---

## 五、设计约束与假设

### 约束

1. **依赖 Storage 模块**：底层文件读写通过 Storage 模块抽象
2. **依赖 Bus 模块**：事件广播通过 confirmation-bus 模块
3. **实时写入策略**：每次更新立即持久化，不延迟批量写入
4. **Part 分离存储**：Message 和 Part 分开存储，支持独立更新

### 假设

1. Storage 模块的写入操作是原子性的
2. 同一 sessionId 在同一时刻只有一个 lifecycle 实例在写入消息
3. Bus 事件发布是同步的，不阻塞主流程

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| lifecycle | 被依赖 | lifecycle 调用 message 接口读写消息 |
| Session | 被依赖 | Session.remove() 调用 removeMessages() 清理消息 |
| Context | 被依赖 | 获取历史、创建 summary Message、标记 compacted |
| SubagentExecutor | 被依赖 | 创建和更新 SubtaskPart 记录子代理执行 |
| Storage | 依赖 | 使用 Storage 进行底层文件读写 |
| Bus (confirmation-bus) | 依赖 | 使用 Bus 广播消息更新事件 |
| system-prompts | 独立 | 系统提示词由独立模块管理 |
| CLI/UI | 被依赖 | UI 层订阅消息事件以实时更新显示 |


### 与 Agent 模块的交互说明

Message 模块与 Agent 模块的交互主要体现在以下几个方面：

1. **消息级 Agent 标识**：UserMessage 和 AssistantMessage 都包含 `agent` 字段，记录消息所属的 Agent 名称。这由 lifecycle 在创建消息时传入。

2. **SubtaskPart 子代理记录**：当 SubagentExecutor 启动子代理时，会在父会话消息中创建 SubtaskPart，记录子代理的执行状态、结果和关联的子会话 ID。

3. **子会话消息隔离**：子代理的消息存储在独立的子会话中，通过 SubtaskPart.childSessionId 与父会话关联，支持按需查看子代理执行详情。

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] Part 类型完整对齐 opencode，但功能可分阶段实现
- [x] 与 Agent 模块（SubagentExecutor）的交互关系明确
