# message 模块 test.md

本文档描述 `message` 模块的测试范围与验证策略。目标是验证模块在真实协作环境中是可信的。

---

## 一、Test Scope（测试范围）

### 覆盖的职责

本模块测试覆盖以下 `goals-duty.md` 中定义的职责：

| 职责 | 测试重点 |
|------|----------|
| D1: 消息类型定义 | 类型结构正确性（通过 TypeScript 编译验证） |
| D2: Part 类型定义 | 类型结构正确性（通过 TypeScript 编译验证） |
| D3: 消息 CRUD 操作 | CRUD 接口行为正确性 |
| D4: 消息格式转换 | toModelMessages 转换正确性 |
| D5: 消息 ID 生成 | ID 格式和唯一性 |
| D6: 事件广播 | 事件发布时机和内容正确性 |

### 不在测试范围内

- lifecycle 模块的执行逻辑
- Storage 模块的实际文件读写（使用 mock）
- Bus 模块的事件分发（使用 mock）
- LLM 响应解析（由 llm-client 负责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：消息 CRUD

#### 场景 1.1：创建消息

**前置条件**：Storage mock 已准备

**操作**：调用 `updateMessage(userMessage)`

**预期结果**：
- Storage.write 被调用，路径为 `["message", sessionId, messageId]`
- Bus.publish 被调用，事件类型为 `Message.Event.Updated`
- 返回的消息与输入一致

#### 场景 1.2：更新消息

**前置条件**：消息已存在

**操作**：调用 `updateMessage(updatedMessage)`

**预期结果**：
- Storage.write 被调用，覆盖原有消息
- Bus.publish 被调用
- 返回更新后的消息

#### 场景 1.3：获取消息列表

**前置条件**：会话中存在多条消息，每条消息有多个 Part

**操作**：调用 `getMessages(sessionId)`

**预期结果**：
- 返回 MessageWithParts 数组
- 每条消息包含正确的 Part 列表
- 消息按 ID 排序（时间正序）

#### 场景 1.4：获取单条消息

**前置条件**：消息存在

**操作**：调用 `getMessage(sessionId, messageId)`

**预期结果**：
- 返回 MessageWithParts
- 包含所有关联的 Part

#### 场景 1.5：获取不存在的消息

**前置条件**：消息不存在

**操作**：调用 `getMessage(sessionId, "nonexistent")`

**预期结果**：
- 返回 null

#### 场景 1.6：删除消息

**前置条件**：消息存在，有多个 Part

**操作**：调用 `removeMessage(sessionId, messageId)`

**预期结果**：
- 所有 Part 被删除
- 消息被删除
- 为每个 Part 广播 PartRemoved 事件
- 广播 Message.Removed 事件

#### 场景 1.7：批量删除会话消息

**前置条件**：会话中有多条消息，每条消息有多个 Part

**操作**：调用 `removeMessages(sessionId)`

**预期结果**：
- 所有消息和 Part 被删除
- 为每条消息广播 Removed 事件
- Storage.delete 被正确调用

#### 场景 1.8：删除空会话的消息

**前置条件**：会话中没有消息

**操作**：调用 `removeMessages(sessionId)`

**预期结果**：
- 不抛出错误
- 不广播任何事件

---

### 场景组 2：Part CRUD

#### 场景 2.1：创建 Part

**前置条件**：消息已存在

**操作**：调用 `updatePart(textPart)`

**预期结果**：
- Storage.write 被调用，路径为 `["part", messageId, partId]`
- Bus.publish 被调用，事件类型为 `Message.Event.PartUpdated`

#### 场景 2.2：流式更新 Part（带 delta）

**前置条件**：TextPart 已存在

**操作**：调用 `updatePart({ part: textPart, delta: "new text" })`

**预期结果**：
- Storage.write 被调用
- Bus.publish 被调用，事件包含 delta 字段

#### 场景 2.3：获取 Part 列表

**前置条件**：消息有多个 Part

**操作**：调用 `getParts(messageId)`

**预期结果**：
- 返回 Part 数组
- 按 ID 排序

#### 场景 2.4：删除单个 Part

**前置条件**：Part 存在

**操作**：调用 `removePart(messageId, partId)`

**预期结果**：
- Part 被删除
- 广播 PartRemoved 事件

---

### 场景组 3：消息格式转换

#### 场景 3.1：转换用户消息

**前置条件**：UserMessage 有 TextPart

**操作**：调用 `toModelMessages([userMessageWithParts])`

**预期结果**：
- 返回 `{ role: 'user', content: ... }`
- content 包含 TextPart 的文本

#### 场景 3.2：转换助手消息（含工具调用）

**前置条件**：AssistantMessage 有 TextPart 和已完成的 ToolPart

**操作**：调用 `toModelMessages([assistantMessageWithParts])`

**预期结果**：
- 返回的消息包含 text part 和 tool invocation
- 工具调用格式正确

#### 场景 3.3：转换助手消息（有错误）

**前置条件**：AssistantMessage 有 error 字段

**操作**：调用 `toModelMessages([errorMessageWithParts])`

**预期结果**：
- 错误消息被过滤（或根据策略保留部分内容）

#### 场景 3.4：过滤无效 Part

**前置条件**：TextPart 设置 ignored = true

**操作**：调用 `toModelMessages([messageWithIgnoredPart])`

**预期结果**：
- ignored 的 Part 不包含在输出中

---

### 场景组 4：ID 生成

#### 场景 4.1：生成 messageId

**操作**：调用 `generateMessageId()` 多次

**预期结果**：
- 格式为 `message_<timestamp>_<random>`
- 每次调用返回不同的 ID

#### 场景 4.2：生成 partId

**操作**：调用 `generatePartId()` 多次

**预期结果**：
- 格式为 `part_<timestamp>_<random>`
- 每次调用返回不同的 ID

---

### 场景组 5：工厂函数

#### 场景 5.1：创建 UserMessage

**操作**：调用 `createUserMessage(input)`

**预期结果**：
- 返回完整的 UserMessage
- id 自动生成
- time.created 自动设置
- role 为 'user'

#### 场景 5.2：创建 AssistantMessage

**操作**：调用 `createAssistantMessage(input)`

**预期结果**：
- 返回完整的 AssistantMessage
- tokens 初始化为 0
- cost 初始化为 0
- role 为 'assistant'

#### 场景 5.3：创建各种 Part

**操作**：调用 createTextPart, createToolPart, createReasoningPart 等

**预期结果**：
- 返回完整的 Part 对象
- id 自动生成
- type 正确设置

---

## 三、Integration Points（集成点测试）

### 与 Storage 的集成

| 集成点 | 验证重点 |
|--------|----------|
| 消息写入 | 路径格式正确，数据完整 |
| Part 写入 | 路径格式正确，与消息关联正确 |
| 消息读取 | 能正确解析 JSON |
| 列表查询 | 能正确遍历目录 |
| 删除操作 | 能正确删除文件 |

**失败处理**：
- Storage.write 失败时，抛出异常，不广播事件
- Storage.read 失败时，返回 null
- Storage.list 失败时，返回空数组

### 与 Bus 的集成

| 集成点 | 验证重点 |
|--------|----------|
| 消息更新事件 | 事件类型正确，数据完整 |
| Part 更新事件 | 包含 delta（如有） |
| 删除事件 | 包含正确的 ID 信息 |

**失败处理**：
- Bus.publish 失败时，应记录错误但不阻塞主流程

### 与 lifecycle 的集成

| 集成点 | 验证重点 |
|--------|----------|
| 创建消息流程 | lifecycle 调用工厂函数 -> updateMessage |
| 流式更新流程 | lifecycle 多次调用 updatePart（带 delta） |
| 读取消息流程 | lifecycle 调用 getMessages -> toModelMessages |

### 与 Session 的集成

| 集成点 | 验证重点 |
|--------|----------|
| 删除会话消息 | Session.delete() 调用 removeMessages() |
| 删除后验证 | 消息和 Part 均已删除 |

---

## 四、Verification Strategy（验证策略）

### 单元测试

| 组件 | 测试策略 |
|------|----------|
| MessageManager | mock Storage 和 Bus，验证 CRUD 逻辑 |
| MessageStore | mock Storage，验证路径生成和读写 |
| MessageConverter | 纯函数测试，无需 mock |
| 工厂函数 | 纯函数测试，验证默认值和 ID 生成 |
| ID 生成器 | 验证格式和唯一性 |

### 集成测试

| 场景 | 测试策略 |
|------|----------|
| 端到端消息流程 | 使用真实 Storage（内存实现），验证完整流程 |
| 事件广播 | 使用真实 Bus，验证事件订阅者收到正确事件 |

### Mock 策略

```typescript
// Storage mock 示例
const mockStorage = {
  data: new Map<string, any>(),
  
  async write(key: string[], data: any) {
    this.data.set(key.join('/'), data)
  },
  
  async read<T>(key: string[]): Promise<T | null> {
    return this.data.get(key.join('/')) ?? null
  },
  
  async list(prefix: string[]): Promise<string[][]> {
    const prefixStr = prefix.join('/')
    return [...this.data.keys()]
      .filter(k => k.startsWith(prefixStr))
      .map(k => k.split('/'))
  },
  
  async delete(key: string[]) {
    this.data.delete(key.join('/'))
  }
}

// Bus mock 示例
const mockBus = {
  events: [] as any[],
  
  publish(event: any, data: any) {
    this.events.push({ event, data })
  },
  
  clear() {
    this.events = []
  }
}
```

### 类型验证

- 使用 TypeScript 编译器验证类型定义正确性
- 使用 zod 或类似库进行运行时类型验证（如需要）

---

## 五、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] 测试围绕职责和交互边界，而非代码结构
- [x] Mock 策略清晰，便于实现
