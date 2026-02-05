# tool-scheduler 模块 dfd-interface.md

本文档描述 `tool-scheduler` 模块的数据流与对外接口。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

ToolScheduler 位于 Agent 与 tools/Policy/Permission 之间，是工具调用的调度中心。

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| **Agent** | 输入 | 工具调用请求、工具列表查询 |
| **Policy** | 输入 | 模式查询、决策查询 |
| **Permission** | 双向 | 用户确认请求和响应 |
| **tools** | 输出 | 工具执行 |
| **Bus** | 输出 | 状态变化事件 |

### 本文档范围

- 描述工具调用的完整数据流
- 定义 ToolScheduler 的对外接口
- 说明与各模块的交互方式

---

## 二、Data Flow Description（数据流描述）

### 2.1 主流程：工具调用执行

```
Agent                    ToolScheduler              Policy      Permission      tools
  │                           │                       │             │             │
  │  1. execute(request)      │                       │             │             │
  │-------------------------->│                       │             │             │
  │                           │                       │             │             │
  │              2. 验证工具存在                       │             │             │
  │              3. 获取工具类别                       │             │             │
  │                           │                       │             │             │
  │                           │ 4. check(category)    │             │             │
  │                           │---------------------->│             │             │
  │                           │                       │             │             │
  │                           │ 5. decision           │             │             │
  │                           │<----------------------│             │             │
  │                           │                       │             │             │
  │          [ALLOW]          │                       │             │             │
  │              6. 并发检查   │                       │             │             │
  │                           │                       │             │             │
  │              [可执行]      │                       │             │             │
  │                           │                       │             │  7. execute │
  │                           │------------------------------------------->│
  │                           │                       │             │             │
  │                           │                       │             │  8. result  │
  │                           │<-------------------------------------------│
  │                           │                       │             │             │
  │  9. ToolCallResult        │                       │             │             │
  │<--------------------------│                       │             │             │
  │                           │                       │             │             │
  │          [ASK]            │                       │             │             │
  │                           │                       │  6. ask()   │             │
  │                           │------------------------------->│             │
  │                           │                       │             │             │
  │                           │                       │  7. 等待响应 │             │
  │                           │<-------------------------------│             │
  │                           │                       │             │             │
  │              [批准] 继续执行流程                    │             │             │
  │              [拒绝] 返回 rejected                  │             │             │
  │                           │                       │             │             │
  │          [DENY]           │                       │             │             │
  │  6. rejected result       │                       │             │             │
  │<--------------------------│                       │             │             │
```

### 2.2 并发控制流程

```
ToolScheduler (内部)
     │
     │ 新工具调用请求
     ▼
┌─────────────────────────────────────────────────────────────┐
│                   ConcurrencyController                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  canExecute(category)?                                       │
│       │                                                      │
│       ├── YES ──→ acquire(category)                          │
│       │           执行工具                                    │
│       │           release(category)                          │
│       │           processQueue()                             │
│       │                                                      │
│       └── NO ───→ 加入 pendingQueue                          │
│                   状态设为 queued                             │
│                   等待 processQueue() 调用                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 获取可用工具流程

```
Lifecycle                ToolScheduler              Policy         AgentManager
  │                           │                       │                 │
  │  1. getAvailableTools(agentName)                  │                 │
  │-------------------------->│                       │                 │
  │                           │                       │                 │
  │                           │ 2. getMode()          │                 │
  │                           │---------------------->│                 │
  │                           │                       │                 │
  │                           │ 3. mode               │                 │
  │                           │<----------------------│                 │
  │                           │                       │                 │
  │                           │ 4. get(agentName)     │                 │
  │                           │---------------------------------------->│
  │                           │                       │                 │
  │                           │ 5. AgentConfig (含 tools 配置)          │
  │                           │<----------------------------------------│
  │                           │                       │                 │
  │           6. 根据 mode 过滤工具                    │                 │
  │           7. 根据 Agent.tools 配置过滤            │                 │
  │              (tools[name] === false 则排除)       │                 │
  │                           │                       │                 │
  │  8. ToolDefinition[]      │                       │                 │
  │<--------------------------│                       │                 │
```

**过滤规则**：

1. 首先根据 Policy 模式过滤：
   - Ask/Plan 模式：只保留 readonly 和 network 类别
   - Agent 模式：保留所有类别

2. 然后根据 Agent 工具配置过滤：
   - `tools['*'] = true`：默认启用所有工具
   - `tools['toolName'] = false`：显式禁用特定工具
   - `tools['toolName'] = true`：显式启用特定工具

3. 特殊规则（子代理）：
   - 子代理的 task、todowrite、todoread 工具始终禁用

### 2.4 状态变化通知流程

```
ToolScheduler                     Bus                        UI
     │                             │                          │
     │  1. 状态发生变化             │                          │
     │                             │                          │
     │  2. publish(StatusChanged)  │                          │
     │---------------------------->│                          │
     │                             │                          │
     │                             │  3. 事件分发              │
     │                             │------------------------->│
     │                             │                          │
     │                             │              4. 更新显示  │
```

---

## 三、Interface Definition（接口定义）

### 3.1 对外提供的接口

#### ToolScheduler.execute()

**语义**：执行单个工具调用

**输入**：
```typescript
{
  callId: string           // 调用标识
  toolName: string         // 工具名称
  params: Record<string, unknown>  // 工具参数
  sessionId: string        // 会话标识
  messageId: string        // 消息标识
}
```

**输出**：Promise<ToolCallResult>

**异步特性**：异步，工具执行完成后 resolve

**可能的结果**：
- status: 'success' - 执行成功
- status: 'error' - 执行失败
- status: 'rejected' - 被拒绝（Policy 或用户）
- status: 'cancelled' - 被取消

---

#### ToolScheduler.executeBatch()

**语义**：批量执行工具调用

**输入**：
```typescript
{
  calls: ToolCallRequest[]
}
```

**输出**：Promise<ToolCallResult[]>

**异步特性**：异步，所有工具执行完成后 resolve

**并发行为**：
- 读操作可并行执行（最多5个）
- 写操作串行执行

---

#### ToolScheduler.getAvailableTools()

**语义**：获取当前模式和 Agent 配置下可用的工具列表

**输入**：
```typescript
{
  agentName?: string  // 可选，指定 Agent 名称，用于读取其工具配置
}
```

**输出**：
```typescript
ToolDefinition[]

interface ToolDefinition {
  name: string
  description: string
  parameters: JSONSchema  // 转换后的 JSON Schema
}
```

**过滤逻辑**：
1. 根据 Policy.getMode() 过滤（Ask/Plan 模式限制工具类别）
2. 根据 AgentManager.get(agentName).tools 配置过滤

**用途**：供 Lifecycle 构建 LLM 的工具列表

---

#### ToolScheduler.cancel()

**语义**：取消单个工具调用

**输入**：
- callId: string

**输出**：boolean - 是否成功取消

**行为**：
- 如果工具在队列中：直接移除，状态设为 cancelled
- 如果工具在执行中：发送 abort 信号，状态设为 cancelled

---

#### ToolScheduler.cancelAll()

**语义**：取消所有正在执行和等待的工具调用

**输入**：无

**输出**：无

**用途**：会话结束或用户中断时调用

---

#### ToolScheduler.getStatus()

**语义**：获取工具调用的当前状态

**输入**：
- callId: string

**输出**：ToolCallStatus | null

---

#### ToolScheduler.getPendingCalls()

**语义**：获取所有待处理的工具调用

**输入**：无

**输出**：ToolCall[]

---

### 3.2 工具注册接口

#### ToolScheduler.register()

**语义**：注册工具

**输入**：
- tool: Tool

**输出**：无

**用途**：注册内置工具、扩展工具、MCP 工具

---

#### ToolScheduler.registerCategory()

**语义**：注册或覆盖工具类别

**输入**：
- toolName: string
- category: ToolCategory

**输出**：无

**用途**：扩展工具声明自己的类别

---

### 3.3 发布的事件

#### ToolScheduler.Event.StatusChanged

**语义**：工具调用状态变化

**携带数据**：
```typescript
{
  callId: string
  toolName: string
  previousStatus: ToolCallStatus
  currentStatus: ToolCallStatus
  timestamp: number
}
```

**订阅者**：UI 层

---

#### ToolScheduler.Event.ExecutionStarted

**语义**：工具开始执行

**携带数据**：
```typescript
{
  callId: string
  toolName: string
  params: Record<string, unknown>
  timestamp: number
}
```

---

#### ToolScheduler.Event.ExecutionCompleted

**语义**：工具执行完成

**携带数据**：
```typescript
{
  callId: string
  toolName: string
  result: ToolCallResult
  timestamp: number
}
```

---

### 3.4 依赖的外部接口

#### Policy.getMode()

**语义**：获取当前工作模式

**用途**：过滤可用工具

---

#### Policy.check()

**语义**：检查工具执行决策

**输入**：category: ToolCategory

**输出**：PolicyDecision ('allow' | 'deny' | 'ask')

---

#### AgentManager.get()

**语义**：获取 Agent 配置

**输入**：agentName: string

**输出**：Promise<AgentConfig>

**用途**：获取 Agent 的工具配置（tools 字段）用于过滤可用工具

---

#### Permission.ask()

**语义**：请求用户确认

**用途**：Policy 返回 'ask' 时调用

---

#### Bus.publish()

**语义**：发布事件

**用途**：发布状态变化事件

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| ToolCallRequest | Agent | 工具调用请求 |
| ToolCall | ToolScheduler | 内部状态对象 |
| ToolCallResult | ToolScheduler | 执行结果（包装 tool 输出） |
| ToolDefinition | ToolScheduler | 工具定义（从 Tool 转换） |

### 4.2 数据更新责任

| 数据 | 更新者 | 更新时机 |
|------|--------|----------|
| ToolCall.status | ToolScheduler | 状态转换时 |
| ConcurrencyState | ToolScheduler | 工具开始/结束执行时 |
| pendingQueue | ToolScheduler | 入队/出队时 |

### 4.3 责任边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 工具调度 | ToolScheduler | Agent, tools |
| 工具实现 | tools | ToolScheduler |
| 策略决策 | Policy | ToolScheduler |
| 用户确认 | Permission | ToolScheduler |
| 状态存储 | ToolScheduler | tools |
| 并发控制 | ToolScheduler | tools |

---

## 五、接口使用示例

### 5.1 Agent 调用工具

```typescript
// Agent 中
async function handleToolCall(toolCall: LLMToolCall) {
  const result = await ToolScheduler.execute({
    callId: toolCall.id,
    toolName: toolCall.name,
    params: toolCall.arguments,
    sessionId: currentSession.id,
    messageId: currentMessage.id,
  })

  if (result.status === 'success') {
    return result.output
  } else if (result.status === 'rejected') {
    return `Tool execution was rejected: ${result.error?.message}`
  } else {
    return `Tool execution failed: ${result.error?.message}`
  }
}
```

### 5.2 Agent 获取工具列表

```typescript
// Agent 构建 LLM 请求时
const tools = ToolScheduler.getAvailableTools()
const llmRequest = {
  messages: [...],
  tools: tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }))
}
```

### 5.3 UI 订阅状态变化

```typescript
// UI 中
Bus.subscribe(ToolScheduler.Event.StatusChanged, (event) => {
  updateToolCallDisplay(event.callId, event.currentStatus)
})

Bus.subscribe(ToolScheduler.Event.ExecutionCompleted, (event) => {
  showToolResult(event.callId, event.result)
})
```

---

## 六、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 数据责任边界清晰
- [x] 接口定义与 data-model.md 中的类型一致
- [x] 事件定义与 architecture.md 中的设计一致
