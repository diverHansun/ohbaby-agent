# message 模块 dfd-interface.md

本文档描述 `message` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

message 模块位于 ohbaby-code 的核心层，作为消息内容管理的中心：

```
┌─────────────────────────────────────────────────────────────────┐
│ lifecycle（调用层）                                              │
└────────────────────────┬────────────────────────────────────────┘
                         │ 读写消息
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       MessageManager                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 管理消息和 Part 的 CRUD，格式转换，事件广播               │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬───────────┬───────────┬────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
      Storage       Bus       UI 层
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| lifecycle | 输入 | 接收消息读写请求 |
| Session | 输入 | Session.delete() 调用 removeMessages() |
| Context | 输入 | 获取历史、创建 summary Message、标记 compacted |
| SubagentExecutor | 输入 | 创建和更新 SubtaskPart |
| Storage | 输出 | 持久化消息和 Part 到文件系统 |
| Bus (confirmation-bus) | 输出 | 广播消息更新事件 |
| UI/CLI | 输出（通过 Bus） | UI 订阅事件以实时更新 |

---

## 二、Data Flow Description（数据流描述）

### 主数据流 1：创建用户消息

```
1. [外部] lifecycle 处理用户输入
   └── 输入：sessionId, userRequest, agent, model

2. [lifecycle] 构建 UserMessage
   ├── 调用 createUserMessage() 工厂函数
   │   ├── 生成 messageId
   │   └── 构建 UserMessage 对象
   └── 得到 UserMessage

3. [lifecycle -> MessageManager] 写入消息
   ├── 调用 MessageManager.updateMessage(userMessage)
   ├── MessageManager 调用 MessageStore.writeMessage(message)
   └── MessageStore 调用 Storage.write(["message", sessionId, messageId], message)

4. [MessageManager] 广播事件
   └── 调用 Bus.publish(Message.Event.Updated, { info: message })

5. [lifecycle -> MessageManager] 写入消息内容
   ├── 调用 MessageManager.updatePart(textPart)
   │   └── 包含用户输入的 TextPart
   ├── MessageStore 调用 Storage.write(["part", messageId, partId], part)
   └── Bus.publish(Message.Event.PartUpdated, { part })

6. [外部] 返回创建的消息
   └── 供后续引用
```

### 主数据流 2：创建助手消息（流式）

```
1. [外部] lifecycle 开始 LLM 调用
   └── 输入：sessionId, parentId (UserMessage ID)

2. [lifecycle] 构建 AssistantMessage
   ├── 调用 createAssistantMessage() 工厂函数
   │   ├── 生成 messageId
   │   └── 构建初始 AssistantMessage（tokens = 0, cost = 0）
   └── 得到 AssistantMessage

3. [lifecycle -> MessageManager] 写入消息
   ├── 调用 MessageManager.updateMessage(assistantMessage)
   └── Bus.publish(Message.Event.Updated, { info: message })

4. [lifecycle] 处理 LLM 流式响应
   │
   ├── 4.1 收到 text-start
   │   ├── 创建 TextPart（text = ""）
   │   └── 调用 MessageManager.updatePart(textPart)
   │
   ├── 4.2 收到 text-delta
   │   ├── 追加文本：textPart.text += delta
   │   └── 调用 MessageManager.updatePart({ part: textPart, delta })
   │       └── Bus.publish(Message.Event.PartUpdated, { part, delta })
   │
   ├── 4.3 收到 tool-call
   │   ├── 创建 ToolPart（state = running）
   │   └── 调用 MessageManager.updatePart(toolPart)
   │
   ├── 4.4 收到 tool-result
   │   ├── 更新 ToolPart（state = completed）
   │   └── 调用 MessageManager.updatePart(toolPart)
   │
   ├── 4.5 收到 step-finish
   │   ├── 创建 StepFinishPart（含 tokens, cost）
   │   ├── 更新 AssistantMessage（累加 tokens, cost）
   │   └── 调用 MessageManager.updateMessage(assistantMessage)
   │
   └── 4.6 完成
       ├── 设置 AssistantMessage.time.completed
       ├── 设置 AssistantMessage.finish
       └── 调用 MessageManager.updateMessage(assistantMessage)

5. [外部] 流式处理完成
```

### 主数据流 3：读取会话消息

```
1. [外部] lifecycle 开始新一轮对话
   └── 输入：sessionId

2. [lifecycle -> MessageManager] 获取消息列表
   ├── 调用 MessageManager.getMessages(sessionId)
   │
   ├── 2.1 [MessageStore] 读取消息列表
   │   ├── 调用 Storage.list(["message", sessionId])
   │   └── 遍历读取每条消息
   │
   └── 2.2 [MessageStore] 读取每条消息的 Part
       ├── 调用 Storage.list(["part", messageId])
       └── 组装 MessageWithParts

3. [外部] 返回 MessageWithParts[]
   └── 按消息 ID 排序

4. [lifecycle] 转换为 LLM 格式
   ├── 调用 MessageConverter.toModelMessages(messages)
   └── 得到 ModelMessage[]（LLM SDK 格式）
```

### 主数据流 4：删除消息

```
1. [外部] 需要删除消息
   └── 输入：sessionId, messageId

2. [MessageManager] 删除消息
   ├── 调用 MessageStore.getParts(messageId)
   ├── 遍历删除所有 Part
   │   ├── 调用 Storage.delete(["part", messageId, partId])
   │   └── Bus.publish(Message.Event.PartRemoved, { sessionId, messageId, partId })
   ├── 删除消息本身
   │   ├── 调用 Storage.delete(["message", sessionId, messageId])
   │   └── Bus.publish(Message.Event.Removed, { sessionId, messageId })
```

### 主数据流 5：删除会话的所有消息（供 Session 调用）

```
1. [Session] 删除会话时调用
   └── 输入：sessionId

2. [MessageManager] 批量删除消息
   ├── 调用 MessageStore.getMessages(sessionId)
   ├── 遍历每条消息
   │   ├── 删除所有 Part
   │   └── 删除消息本身
   └── 广播删除事件
```

### 主数据流 6：子代理执行记录（SubtaskPart）

```
1. [SubagentExecutor] 开始执行子代理任务
   +-- 输入：parentSessionId, prompt, description, agentName

2. [SubagentExecutor -> SessionManager] 创建子会话
   |-- 调用 SessionManager.create(projectDirectory, { parentId, title, agentName })
   +-- 得到 childSession（含 childSessionId）

3. [SubagentExecutor -> MessageManager] 创建 SubtaskPart
   |-- 创建 SubtaskPart
   |   |-- agent: agentName
   |   |-- childSessionId: childSession.id
   |   |-- status: 'pending'
   |   |-- prompt, description
   |   +-- time: { start: Date.now() }
   +-- 调用 MessageManager.updatePart(subtaskPart)

4. [SubagentExecutor] 更新状态为 running
   |-- subtaskPart.status = 'running'
   +-- 调用 MessageManager.updatePart(subtaskPart)

5. [SubagentExecutor] 在子会话中执行子代理
   |-- 使用 childSessionId 创建子代理 lifecycle
   |-- 子代理的消息写入子会话
   +-- 等待子代理完成

6. [SubagentExecutor] 完成后更新 SubtaskPart
   |-- 成功：
   |   |-- subtaskPart.status = 'completed'
   |   |-- subtaskPart.result = 子代理返回的摘要
   |   +-- subtaskPart.time.end = Date.now()
   |-- 失败：
   |   |-- subtaskPart.status = 'failed'
   |   |-- subtaskPart.error = 错误信息
   |   +-- subtaskPart.time.end = Date.now()
   +-- 调用 MessageManager.updatePart(subtaskPart)

7. [外部] 父会话继续执行
   +-- 主代理可以读取 subtaskPart.result 继续对话
```

### 主数据流 7：读取子代理执行历史

```
1. [外部] 查看会话的子代理执行记录
   +-- 输入：sessionId

2. [MessageManager] 获取消息列表
   |-- 调用 MessageManager.getMessages(sessionId)
   +-- 返回包含 SubtaskPart 的消息

3. [外部] 过滤 SubtaskPart
   |-- 从消息的 parts 中过滤 type === 'subtask'
   +-- 获取所有子代理执行记录

4. [外部] 根据需要查看子会话详情
   |-- 从 SubtaskPart.childSessionId 获取子会话 ID
   +-- 调用 MessageManager.getMessages(childSessionId) 查看子会话消息
```

### 错误数据流

```
[任意 Storage 操作发生错误]
    |
    |-- 写入错误
    |   |-- 抛出异常，由调用方处理
    |   +-- 不广播事件
    |
    +-- 读取错误
        |-- 返回 null 或空数组
        +-- 调用方需处理缺失情况
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外接口（公共 API）

#### MessageManager.updateMessage()

创建或更新消息。

```
输入：
  - message: Message - 完整的消息对象

输出：
  - Promise<Message>

说明：
  - 如果消息不存在，创建新消息
  - 如果消息已存在，更新消息
  - 自动广播 Message.Event.Updated 事件
```

#### MessageManager.updatePart()

创建或更新 Part。

```
输入：
  - input: Part | { part: Part; delta?: string }
    - Part: 完整的 Part 对象
    - delta: 可选的增量内容（用于流式更新）

输出：
  - Promise<Part>

说明：
  - 如果 Part 不存在，创建新 Part
  - 如果 Part 已存在，更新 Part
  - 自动广播 Message.Event.PartUpdated 事件（含 delta）
```

#### MessageManager.getMessages()

获取会话的所有消息（含 Part）。

```
输入：
  - sessionId: string
  - options?: {
      limit?: number    // 返回最近 N 条消息
    }

输出：
  - Promise<MessageWithParts[]>

说明：
  - 返回消息及其所有 Part
  - 按消息 ID 排序（时间正序）
```

#### MessageManager.getMessage()

获取单条消息（含 Part）。

```
输入：
  - sessionId: string
  - messageId: string

输出：
  - Promise<MessageWithParts | null>

说明：
  - 返回消息及其所有 Part
  - 如果消息不存在，返回 null
```

#### MessageManager.getParts()

获取消息的所有 Part。

```
输入：
  - messageId: string

输出：
  - Promise<Part[]>

说明：
  - 返回 Part 列表，按 ID 排序
```

#### MessageManager.removeMessage()

删除消息及其所有 Part。

```
输入：
  - sessionId: string
  - messageId: string

输出：
  - Promise<void>

说明：
  - 删除消息及所有关联的 Part
  - 广播 Message.Event.Removed 事件
  - 为每个删除的 Part 广播 Message.Event.PartRemoved 事件
```

#### MessageManager.removePart()

删除单个 Part。

```
输入：
  - messageId: string
  - partId: string

输出：
  - Promise<void>

说明：
  - 只删除指定的 Part
  - 广播 Message.Event.PartRemoved 事件
```

#### MessageManager.removeMessages()

删除会话的所有消息。

```
输入：
  - sessionId: string

输出：
  - Promise<void>

说明：
  - 删除指定会话的所有消息和 Part
  - 由 Session.delete() 调用
  - 为每个删除的消息广播事件
```

#### MessageConverter.toModelMessages()

将内部消息格式转换为 LLM SDK 格式。

```
输入：
  - messages: MessageWithParts[] - 内部消息列表
  - options?: {
      curated?: boolean        // 是否过滤无效消息（默认 true）
      skipCompacted?: boolean  // 是否跳过已压缩的 tool output（默认 true）
    }

输出：
  - ModelMessage[] - LLM SDK 格式的消息列表

说明：
  - 过滤无效消息（如错误中断的消息）
  - 转换 Part 为 LLM 可理解的格式
  - 处理工具调用和结果的配对
  - 跳过已标记 compacted 的 tool output（ToolPart.state.time.compacted 存在时）
  - 对于 summary Message（AssistantMessage.summary = true），保留其 TextPart 作为压缩摘要
```

### 3.2 工厂函数

#### createUserMessage()

创建用户消息。

```
输入：
  - input: {
      sessionId: string
      agent: string
      model: { providerId: string; modelId: string }
      system?: string
      tools?: Record<string, boolean>
    }

输出：
  - UserMessage

说明：
  - 自动生成 messageId
  - 自动设置 time.created
```

#### createAssistantMessage()

创建助手消息。

```
输入：
  - input: {
      sessionId: string
      parentId: string
      agent: string
      providerId: string
      modelId: string
      path: { cwd: string; root: string }
    }

输出：
  - AssistantMessage

说明：
  - 自动生成 messageId
  - 自动设置 time.created
  - 初始化 tokens 和 cost 为 0
```

#### createTextPart() / createToolPart() / ...

创建各种 Part。

```
输入：
  - 各 Part 类型所需的字段

输出：
  - 对应类型的 Part

说明：
  - 自动生成 partId
```

#### createSubtaskPart()

创建子代理任务 Part（供 SubagentExecutor 使用）。

```
输入：
  - input: {
      sessionId: string         // 父会话 ID
      messageId: string         // 父消息 ID
      prompt: string            // 子任务提示词
      description: string       // 子任务描述
      agent: string             // 子代理名称（explore / research）
      childSessionId: string    // 子会话 ID
    }

输出：
  - SubtaskPart

说明：
  - 自动生成 partId
  - 初始化 status 为 'pending'
  - 初始化 time.start 为当前时间
```

### 3.3 依赖接口（需要注入的依赖）

#### Storage 接口

```
read<T>(key: string[]): Promise<T | null>
  - 读取指定路径的 JSON 文件

write<T>(key: string[], data: T): Promise<void>
  - 写入 JSON 文件，自动创建目录

list(prefix: string[]): Promise<string[][]>
  - 列出匹配前缀的所有文件路径

delete(key: string[]): Promise<void>
  - 删除指定文件
```

#### Bus 接口

```
publish<T>(event: EventType, data: T): void
  - 发布事件
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| Message | lifecycle（通过工厂函数） | lifecycle 构建并传入 |
| Part | lifecycle（通过工厂函数） | lifecycle 构建并传入 |
| messageId | 工厂函数 | 自动生成 |
| partId | 工厂函数 | 自动生成 |

### 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| Message 内容 | lifecycle | 通过 updateMessage |
| Part 内容 | lifecycle | 通过 updatePart |
| 事件广播 | MessageManager | 自动完成 |

### 数据删除责任

| 数据 | 删除者 | 说明 |
|------|--------|------|
| Message | 调用方（如 Session） | 通过 removeMessage 或 removeMessages |
| Part | MessageManager（随 Message） 或调用方 | 自动或手动 |

### 数据持有责任

| 数据 | 持有者 | 说明 |
|------|--------|------|
| 消息内容（持久化）| message 模块（通过 Storage） | - |
| 消息事件 | Bus 模块 | 分发给订阅者 |
| 消息格式转换 | MessageConverter | 无状态，纯函数 |

---

## 五、接口使用示例（概念说明）

### 创建用户消息和助手消息

```typescript
// 伪代码，说明接口使用方式

// 1. 创建用户消息
const userMessage = createUserMessage({
  sessionId,
  agent: 'default',
  model: { providerId: 'anthropic', modelId: 'claude-3-5-sonnet' }
})
await messageManager.updateMessage(userMessage)

// 2. 创建用户输入的 TextPart
const textPart = createTextPart({
  sessionId,
  messageId: userMessage.id,
  text: userRequest
})
await messageManager.updatePart(textPart)

// 3. 创建助手消息
const assistantMessage = createAssistantMessage({
  sessionId,
  parentId: userMessage.id,
  agent: 'default',
  providerId: 'anthropic',
  modelId: 'claude-3-5-sonnet',
  path: { cwd: '/project', root: '/project' }
})
await messageManager.updateMessage(assistantMessage)

// 4. 流式处理 LLM 响应
let currentTextPart = null
for await (const chunk of llmStream) {
  if (chunk.type === 'text-start') {
    currentTextPart = createTextPart({
      sessionId,
      messageId: assistantMessage.id,
      text: ''
    })
    await messageManager.updatePart(currentTextPart)
  }
  if (chunk.type === 'text-delta') {
    currentTextPart.text += chunk.text
    await messageManager.updatePart({
      part: currentTextPart,
      delta: chunk.text
    })
  }
}

// 5. 更新助手消息完成状态
assistantMessage.time.completed = Date.now()
assistantMessage.finish = 'stop'
await messageManager.updateMessage(assistantMessage)
```

### 读取消息并转换

```typescript
// 1. 获取会话消息
const messages = await messageManager.getMessages(sessionId)

// 2. 转换为 LLM 格式
const modelMessages = toModelMessages(messages)

// 3. 发送给 LLM
const response = await llm.chat(modelMessages)
```

---

## 六、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义关注语义，未绑定具体实现
- [x] 明确了与 lifecycle 的协作方式
- [x] 事件广播机制明确
- [x] 流式更新场景覆盖完整
- [x] 子代理执行记录（SubtaskPart）数据流完整
- [x] SubagentExecutor 与 Message 模块的交互明确
