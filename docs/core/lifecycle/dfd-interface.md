# lifecycle 模块 dfd-interface.md

本文档描述 `lifecycle` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

---

## 一、Context and Scope（上下文与范围）

### 模块位置

lifecycle 位于 ohbaby-agent 架构的核心层，作为执行引擎协调多个模块：

```
┌─────────────────────────────────────────────────────────────────┐
│ 调用层（CLI / IDE Extension / Web）                             │
└────────────────────────┬────────────────────────────────────────┘
                         │ 用户请求
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       lifecycle                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 协调 LLM 调用与工具执行，返回执行事件与最终结果            │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬───────────┬───────────┬───────────┬────────────────────┘
         │           │           │           │
         ▼           ▼           ▼           ▼
    LLMClient   ToolScheduler    Message     AgentManager
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| 调用层 | 输入 | 接收用户请求，消费执行事件 |
| LLMClient | 输出 | 发送消息，接收流式响应 |
| ToolScheduler | 输出 | 发送工具调用请求，接收执行结果 |
| Message | 双向 | 读取历史消息，写入新消息和 Part |
| Memory | 输入 | 会话开始时加载长期记忆 |
| AgentManager | 输入 | 获取 Agent 配置 |

---

## 二、Data Flow Description（数据流描述）

### 主数据流：用户请求到最终响应

```
1. [外部] 调用层发起请求
   └── 输入：sessionId, userMessage, agentName, signal
   
2. [lifecycle] 初始化执行
   ├── 检查并发状态（sessionId 是否已在执行）
   ├── 从 AgentManager 获取 Agent 配置
   ├── 从 Memory Module 加载长期记忆 -> Memory.load()
   ├── 从 Message 读取历史消息
   └── 写入用户消息 → Message.updateMessage()
   
3. [lifecycle] 进入外层循环
   │
   ├── 3.1 [内部] 检查退出条件
   │   ├── step >= maxSteps -> 退出
   │   ├── signal.aborted -> 退出
   │   └── lastFinishReason == 'stop' -> 退出
   │
   ├── 3.2 [lifecycle -> LLMClient] 发起 LLM 调用
   │   ├── 输入：messages（历史 + 系统提示 + 用户请求）
   │   └── 输出：流式响应（delta, toolCalls, finishReason）
   │
   ├── 3.3 [lifecycle] 处理流式响应
   │   └── yield LoopEvent { type: 'llm:delta', content }
   │
   ├── 3.4 [条件] 如果 LLM 返回 tool_calls
   │   │
   │   ├── 3.4.1 [lifecycle -> ToolScheduler] 执行工具
   │   │   ├── yield LoopEvent { type: 'tool:start', toolName }
   │   │   ├── 输入：toolCalls 列表
   │   │   └── 输出：toolResults 列表
   │   │
   │   ├── 3.4.2 [lifecycle] 格式化工具结果
   │   │   └── 转换为 function_result 消息格式
   │   │
   │   └── 3.4.3 [lifecycle] 添加到消息历史
   │       └── 继续循环
   │
   └── 3.5 [lifecycle] 单步完成
       └── yield LoopEvent { type: 'step:complete', step }

4. [lifecycle] 循环结束
   ├── 构建 LoopResult
   ├── 通过 Message 写入新消息
   └── 清理并发状态

5. [外部] 调用层接收结果
   └── 输出：LoopResult
```

### 错误数据流

```
[任意步骤发生错误]
    │
    ├── 可重试错误（如网络超时）
    │   ├── [TurnProcessor] 内部重试（最多 3 次）
    │   └── 重试成功 -> 继续正常流程
    │
    ├── 工具执行错误
    │   ├── yield LoopEvent { type: 'tool:error', toolName, error }
    │   ├── 格式化错误信息作为工具结果
    │   └── 继续循环，让 LLM 处理错误
    │
    └── 不可恢复错误
        ├── yield LoopEvent { type: 'error', error }
        ├── 构建失败的 LoopResult
        └── 退出循环
```

### 取消数据流

```
[调用层] controller.abort()
    │
    ▼
[lifecycle] signal.aborted == true
    │
    ├── 中断当前 LLM 调用
    ├── yield LoopEvent { type: 'step:complete', status: 'abort' }
    ├── 构建 LoopResult { finishReason: 'abort' }
    └── 清理并发状态
```

### 消息组装流程

lifecycle 内部需要组装发送给 LLM 的完整消息列表，流程如下：

```
消息组装步骤：

1. 获取系统提示词
   ├── 调用 AgentManager.getSystemPrompt(agentName)
   │   │
   │   └── AgentManager 内部处理：
   │       ├── 获取 Agent 配置
   │       ├── 判断代理类型（主代理/子代理）
   │       ├── 调用 SystemPrompt.assemble() 组装提示词
   │       │   ├── 主代理：Identity + Environment + CustomInstructions
   │       │   └── 子代理：AgentPrompt + Environment（精简版）
   │       └── 返回 string[]
   │
   └── systemMessages = await AgentManager.getSystemPrompt(agentName)

2. 加载长期记忆
   └── memory = await Memory.load(directory)

3. 读取历史消息
   └── messages = await messageManager.getMessages(sessionId)

   说明：返回 MessageWithParts[]

3. 构建用户请求消息
   └── userMessage = { role: 'user', content: request }

4. 组装完整消息列表（发送给 LLM）
   └── messages = [
         ...systemMessages.map(s => ({ role: 'system', content: s })),
         { role: 'system', content: memory.merged, name: 'memory' },
         ...history,
         userMessage
       ]

5. 循环中追加工具调用结果（内存中临时累积）
   ├── 收到 LLM 返回 tool_calls 时：
   │   └── messages.push({ role: 'assistant', content: null, tool_calls })
   └── 工具执行完成后：
       └── messages.push({ role: 'tool', tool_call_id, content: result })
```

### 实时数据写入策略

lifecycle 采用**实时写入**模式，每次状态变化立即通过 Message 模块接口持久化，确保可恢复性：

```
实时写入时机：

1. 用户消息提交时
   ├── await messageManager.updateMessage(userMessage)
   └── await messageManager.updatePart(textPart)
       └── 立即写入 Message 和用户输入的 TextPart

2. LLM 开始响应时
   └── await messageManager.updateMessage(assistantMessage)
       └── 创建 AssistantMessage（tokens = 0, cost = 0）

3. LLM 响应过程中
   ├── 收到 text-start：创建 TextPart
   │   └── await messageManager.updatePart(textPart)
   ├── 收到 text-delta：更新 TextPart
   │   └── await messageManager.updatePart({ part: textPart, delta })
   ├── 收到 reasoning：创建/更新 ReasoningPart
   │   └── await messageManager.updatePart(reasoningPart)
   └── 收到 tool-call：创建 ToolPart（state = running）
       └── await messageManager.updatePart(toolPart)

4. 工具执行完成时
   └── 更新 ToolPart（state = completed/error）
       └── await messageManager.updatePart(toolPart)

5. Step 完成时
   └── await messageManager.updatePart(stepFinishPart)
       └── 包含 tokens、cost 统计

6. LLM 响应完成时
   └── await messageManager.updateMessage({
         ...assistantMessage,
         time: { ...time, completed: Date.now() },
         finish: finishReason,
         tokens: accumulatedTokens,
         cost: accumulatedCost
       })
```

### 各场景的写入行为

```
循环正常完成（finishReason: 'stop'）：
    │
    └── 所有消息已在执行过程中实时写入
        无需额外操作


循环达到 maxSteps 限制：
    │
    ├── 所有消息已实时写入
    │
    └── 最后一条 assistant 消息标记 finishReason: 'maxSteps'


循环被取消（abort）：
    │
    ├── 已写入的消息保留（用户消息、部分助手响应）
    │
    ├── 当前 streaming 的助手消息更新为：
    │   └── status: 'error', content: '${已有内容}\n\n[Interrupted by User]'
    │
    └── 未完成的工具调用消息更新为：
        └── status: 'error', content: 'Interrupted by User'


循环发生不可恢复错误：
    │
    ├── 已写入的消息保留
    │
    └── 当前消息更新为：
        └── status: 'error', error: { name, message }
```

**实时写入的优势**：

1. **可恢复性**：进程崩溃后可从最后写入点恢复
2. **实时可见**：其他客户端可立即看到对话进展
3. **调试友好**：可随时查看当前对话状态

**实时写入的注意事项**：

1. **I/O 开销**：需要控制更新频率，避免过于频繁的写入
2. **状态管理**：需正确处理 streaming/complete/error 状态转换
3. **错误处理**：写入失败时需要重试或记录错误

---

## 三、Interface Definition（接口定义）

### 3.1 对外接口（公共 API）

#### Lifecycle.run()

主执行方法，返回 AsyncGenerator。

```
输入：
- sessionId: string - 会话标识
- request: string - 用户请求文本
- options?: {
    signal?: AbortSignal - 取消信号
    callbacks?: LoopCallbacks - 可选回调
    
    // ===== 子代理相关参数 =====
    parentSessionId?: string - 父 Session ID（子代理执行时必填）
    isSubagent?: boolean - 是否为子代理执行（默认 false）
  }

输出：
- AsyncGenerator<LoopEvent, LoopResult>

特性：
- 异步流式
- 支持 for await 消费
- 完成时返回 LoopResult
- 子代理模式下自动设置上下文隔离（不继承父 Memory）
```

#### Lifecycle.isRunning()

查询指定 session 是否正在执行。

```
输入：
- sessionId: string

输出：
- boolean
```

### 3.2 依赖接口（需要注入的依赖）

#### LLMClient 接口

```
streamChatCompletion(messages, options)
  输入：消息列表、模型配置
  输出：AsyncGenerator<StreamingResponse>
  
  StreamingResponse 包含：
  - type: 'delta' | 'complete'
  - content?: string（文本片段）
  - toolCalls?: ParsedToolCall[]（工具调用）
  - finishReason?: string（完成原因）
```

#### ToolScheduler 接口

```
executeToolCalls(toolCalls, options)
  输入：工具调用列表、执行选项
  输出：Promise<ToolResult[]>
  
  ToolResult 包含：
  - toolCallId: string
  - output: string
  - metadata?: object
  - error?: string
```

#### Message 接口

Message 模块负责管理对话消息，lifecycle 通过该接口读取历史消息和写入新消息/Part。

```
updateMessage(message)
  输入：
    - message: Message - 完整的消息对象
  输出：Promise<Message>
  
  说明：
    - 创建或更新消息
    - 自动广播 Message.Event.Updated 事件

updatePart(input)
  输入：
    - input: Part | { part: Part; delta?: string }
      - Part: 完整的 Part 对象
      - delta: 可选的增量内容（用于流式更新）
  输出：Promise<Part>
  
  说明：
    - 创建或更新 Part
    - 自动广播 Message.Event.PartUpdated 事件（含 delta）

getMessages(sessionId, options?)
  输入：
    - sessionId: string - 会话 ID
    - options?: {
        limit?: number      // 返回最近 N 条消息，默认全部
      }
  输出：Promise<MessageWithParts[]>
  
  说明：
    - 返回消息及其所有 Part
    - 按消息 ID 排序（时间正序）

getParts(messageId)
  输入：
    - messageId: string
  输出：Promise<Part[]>
  
  说明：
    - 返回消息的所有 Part
    - 按 Part ID 排序

toModelMessages(messages)
  输入：
    - messages: MessageWithParts[] - 内部消息列表
  输出：ModelMessage[] - LLM SDK 格式的消息列表
  
  说明：
    - 过滤无效消息（如错误中断的消息）
    - 转换 Part 为 LLM 可理解的格式
    - 处理工具调用和结果的配对
```

**消息格式说明**：

消息采用 OpenAI 兼容格式 + 元数据扩展：

```typescript
// 基础字段（所有消息共有）
interface BaseMessage {
  id: string                    // 消息 ID
  sessionId: string             // 所属会话 ID
  createdAt: number             // 创建时间戳
  updatedAt?: number            // 最后更新时间戳
}

// 用户消息
interface UserMessage extends BaseMessage {
  role: 'user'
  content: string
  attachments?: Attachment[]    // 可选附件
}

// 助手消息
interface AssistantMessage extends BaseMessage {
  role: 'assistant'
  content: string | null
  status: 'streaming' | 'complete' | 'error'
  tool_calls?: ToolCall[]       // 工具调用列表
  finishReason?: string         // 完成原因
  usage?: TokenUsage            // Token 使用统计
  error?: ErrorInfo             // 错误信息
}

// 工具结果消息
interface ToolMessage extends BaseMessage {
  role: 'tool'
  tool_call_id: string
  toolName: string              // 工具名称
  content: string               // 工具执行结果
  status: 'pending' | 'complete' | 'error'
  metadata?: Record<string, unknown>
}

type Message = UserMessage | AssistantMessage | ToolMessage
```

**转换为 OpenAI 格式**：

发送给 LLM 时，需要过滤元数据字段，只保留 OpenAI 标准字段：

```typescript
function toOpenAIFormat(message: Message): ChatCompletionMessageParam {
  // 过滤掉 id, sessionId, createdAt, status 等元数据字段
  // 只保留 role, content, tool_calls, tool_call_id
}
```

#### AgentManager 接口

AgentManager 负责管理 Agent 配置，lifecycle 通过该接口获取当前 Agent 的配置信息和系统提示词。

```
get(agentName)
  输入：
    - agentName: string - Agent 名称
  输出：Promise<AgentConfig>

  AgentConfig 包含：
    - name: string              // Agent 标识名称
    - description?: string      // 代理描述（子代理必填）
    - mode: AgentMode           // 代理模式：'primary' | 'subagent' | 'all'
    - systemPrompt?: string     // 代理专属提示词（子代理设置，主代理不设置）
    - maxSteps: number          // 最大执行步数
    - tools: Record<string, boolean>  // 工具启用配置
    - permission: AgentPermission     // 权限配置
    - temperature?: number      // 模型温度参数
    - model?: { providerID: string; modelID: string }  // 指定模型（可选）

getSystemPrompt(agentName)
  输入：
    - agentName: string - Agent 名称
  输出：Promise<string[]>

  说明：
    - 返回组装后的完整系统提示词
    - 内部调用 SystemPrompt.assemble() 完成组装
    - 主代理：Identity + Environment + CustomInstructions
    - 子代理：AgentPrompt + Environment（精简版）

getDefault()
  输入：无
  输出：Promise<string>

  说明：返回默认主代理名称

list(filter?)
  输入：
    - filter?: { mode?: AgentMode; hidden?: boolean }
  输出：Promise<AgentConfig[]>

  说明：返回所有可用的 Agent 配置列表，支持按模式过滤

#### Memory 接口

Memory 模块负责管理长期记忆文件。

```
load(directory)
  输入：
    - directory: string - 当前工作目录
  输出：Promise<MergedMemory>

  MergedMemory 包含：
    - global: string
    - project: string
    - merged: string
```
```

---

## 四、Data Ownership and Responsibility（数据归属与责任）

### 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| LoopEvent | lifecycle | 执行过程中产生 |
| LoopResult | lifecycle | 执行完成时产生 |
| 消息历史 | Message | lifecycle 读取和写入 |
| 新增消息/Part | lifecycle 构建，Message 存储 | lifecycle 负责构建，Message 负责持久化 |
| 工具结果 | ToolScheduler 产生，lifecycle 格式化 | lifecycle 负责转换为 ToolPart |

### 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| 执行状态（step 等） | lifecycle | 每步更新 |
| 并发状态 | lifecycle | 开始/结束时更新 |
| 消息和 Part | Message | 收到 lifecycle 请求后更新 |

### 数据销毁责任

| 数据 | 销毁者 | 时机 |
|------|--------|------|
| 执行状态 | lifecycle | 执行完成或取消时 |
| 并发状态 | lifecycle | 执行完成或取消时 |
| LoopEvent | 调用层 | 消费后 |

---

## 五、接口使用示例（概念说明）

### 基本使用

```
// 伪代码，说明接口使用方式

const loop = new Lifecycle(deps)

for await (const event of loop.run(sessionId, request)) {
  switch (event.type) {
    case 'llm:delta':
      // 显示流式输出
      break
    case 'tool:start':
      // 显示工具执行提示
      break
    case 'step:complete':
      // 更新进度
      break
  }
}

// 循环结束，获取最终结果在 generator return value 中
```

### 取消执行

```
const controller = new AbortController()
const generator = loop.run(sessionId, request, { signal: controller.signal })

// 需要取消时
controller.abort()
```

---

## 六、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰，无重复处理风险
- [x] 接口定义关注语义，未绑定具体实现
- [x] 消息格式明确定义（用户、助手、工具结果）+ 元数据扩展
- [x] 消息组装流程清晰
- [x] 实时写入时机和策略明确（6 个写入点）
- [x] 区分正常/取消/错误场景的处理方式
- [x] Message 接口支持 updateMessage 和 updatePart 用于流式更新
