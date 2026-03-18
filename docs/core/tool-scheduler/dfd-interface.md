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

### 2.3 Wave-Based 批量执行流程

`executeBatch()` 接收一个 batch（来自 LLM 单次响应的全部工具调用），按 wave 策略分组并行执行。

**Wave 分组规则**：
- **可并行类别**（`readonly` / `network`）：归入同一 wave，内部受读写互斥锁约束（并行上限 5）
- **串行类别**（`write` / `dangerous`）：每个独占一个 wave，必须等前一个 wave 完全结束
- **不参与 wave 分组的类别**（policy 通过后立即执行，不阻塞 wave）：
  - `memory`：始终可并行，不受读写锁限制
  - `subagent`：受独立计数器约束（≤ 3），但不阻塞其他 wave 的执行

> **subagent 不参与 wave 的设计理由**：subagent 是长时间运行的独立任务（可能数分钟），与 readonly 工具（通常毫秒到秒级）混在同一 wave 会导致后续 write wave 被不必要地阻塞。且同一 batch 内 write 工具不可能依赖 subagent 的结果（因为 LLM 此时还未看到 subagent 的返回值），类似 deepagentsjs 的独立 agent 设计。

**Wave 保持原始顺序，不重排序**：wave 按 calls 数组的原始顺序遍历分组。虽然重排序可能提高并发度（将分散的 readonly 工具合并），但 LLM 返回的顺序可能蕾含隐式的执行依赖，保持顺序是更安全的选择。

```
executeBatch([call_A, call_B, call_C, call_D, call_E, call_F])
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  Step 1: 对 batch 中每个 call 并行执行 policy 检查        │
│                                                          │
│  规则：                                                    │
│  - 并行发出所有 policy check，等待全部完成后再分组     │
│  - 包含用户确认（ASK 决策）的等待：                      │
│    · 多个 ASK 请求通过 Permission 串行确认（一次一个）   │
│    · 用户拒绝的 call 状态设为 rejected，不影响其他   │
│    · 超时未响应的 call 状态设为 cancelled            │
│  - 被 reject/cancel 的 calls 不参与 wave 分组          │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  Step 1.5: 分离不参与 wave 的类别                     │
│                                                          │
│  从已通过 policy 的 calls 中分离：                        │
│  - memory 类别 → 立即执行（不等 wave）                   │
│  - subagent 类别 → 立即启动（受独立计数器 ≤3 约束）    │
│  - 其余 calls 进入 wave 分组                             │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  Step 2: 按 category 分 wave                             │
│                                                          │
│  输入示例：                                               │
│    call_A: readonly   ┐                                  │
│    call_B: readonly   ├─→ Wave 1（可并行，Promise.all）  │
│    call_C: network    ┘                                  │
│    call_D: write      ──→ Wave 2（串行，独占）            │
│    call_E: readonly   ──→ Wave 3（可并行，恢复并行）      │
│                                                          │
│  已分离：                                                  │
│    call_F: subagent   ──→ 立即启动（不参与 wave）          │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│  Step 3: 逐 wave 执行 + 并行收集 memory/subagent 结果   │
│                                                          │
│  Wave 1 → Promise.all([call_A, call_B, call_C])         │
│    ├─ call_A(readonly): acquire readingCount++           │
│    ├─ call_B(readonly): acquire readingCount++           │
│    └─ call_C(network):  acquire readingCount++           │
│    → 等待全部完成后进入 Wave 2                            │
│                                                          │
│  Wave 2 → 串行执行 call_D(write)                        │
│    → 等待完成后进入 Wave 3                               │
│                                                          │
│  Wave 3 → Promise.all([call_E])                         │
│    → 全部完成                                              │
│                                                          │
│  → 等待 memory/subagent 完成（如尚未完成）               │
│  → 收集所有结果，按原始 calls 顺序返回                    │
└──────────────────────────────────────────────────────────┘
  │
  ▼
返回 ToolCallResult[]（顺序与输入 calls 一致）
```

**memory 和 subagent 工具的特殊处理**：

```
memory 和 subagent 不参与 wave 分组，在 policy 检查通过后立即执行：
  executeBatch([memory_add, task_research, write_file, read_file])
    │
    ├─ memory_add    → 立即执行，不等 wave 分组
    ├─ task_research → 立即启动，受独立计数器约束
    ├─ read_file     → Wave 1
    └─ write_file    → Wave 2（等 Wave 1 完成）
```

**wave 拆分算法**（伪代码）：

```typescript
function splitIntoWaves(calls: ToolCall[]): ToolCall[][] {
  const waves: ToolCall[][] = []
  let currentWave: ToolCall[] = []

  for (const call of calls) {
    if (call.category === 'memory' || call.category === 'subagent') {
      continue  // memory 和 subagent 单独处理，不入 wave
    }

    const isParallelizable =
      call.category === 'readonly' ||
      call.category === 'network'

    if (isParallelizable) {
      // 如果当前 wave 是串行类别，先结束它
      if (currentWave.length > 0 && !isParallelizableCategory(currentWave[0].category)) {
        waves.push(currentWave)
        currentWave = []
      }
      currentWave.push(call)
    } else {
      // write/dangerous：每个独占一个 wave
      if (currentWave.length > 0) {
        waves.push(currentWave)
      }
      waves.push([call])
      currentWave = []
    }
  }

  if (currentWave.length > 0) waves.push(currentWave)
  return waves
}
```

### 2.4 获取可用工具流程

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

**语义**：批量执行工具调用（来自 LLM 单次响应的所有工具调用）

**输入**：
```typescript
{
  calls: ToolCallRequest[]
}
```

**输出**：Promise<ToolCallResult[]>（顺序与输入 calls 一致）

**异步特性**：异步，所有工具执行完成后 resolve

**Wave-based 并发行为**：

1. **Policy 检查**：对 batch 中所有 calls 并行发出 policy check，等待全部完成（含用户确认）后再分组
   - 需要用户确认的工具（Policy 返回 ASK）通过 Permission 模块串行确认（一次一个确认框）
   - 用户拒绝的 call 状态设为 `rejected`，不参与 wave 分组
   - 超时未响应的 call 状态设为 `cancelled`，不参与 wave 分组
   - 设计理由：LLM 同一次响应中的 tool calls 可能存在依赖关系，全阻塞等待保证语义正确性（与 gemini-cli 一致）

2. **分离不参与 wave 的类别**：
   - `memory`：policy 通过后立即执行，不受读写锁限制
   - `subagent`：policy 通过后立即启动，受独立计数器约束（≤3）

3. **分组**：将剩余 calls 按 category 拆分为多个 wave
   - `readonly`/`network`：归入同一 wave，内部 `Promise.all` 并行执行
   - `write`/`dangerous`：每个独占一个 wave，等上一 wave 全部完成后才执行

4. **执行**：逐 wave 顺序执行，wave 内并行
   - wave 内每个工具的执行仍经过 ConcurrencyController 的 `acquire/release`（见下文两层机制说明）
   - `readonly`/`network` 受读写互斥锁约束，并行上限 5

5. **结果聚合**：等待所有 wave + memory + subagent 全部完成，按原始 calls 顺序返回结果

**调用方**：lifecycle 模块（TurnProcessor），将 LLM 返回的一批 tool calls 整体传入

**`executeBatch()` 与 `ConcurrencyController` 的两层关系**：

```
executeBatch()  [编排层/Wave层]
  │  将 calls 拆分为 wave[]
  │  逐 wave 顺序执行，wave 内 Promise.all
  │  保证：写操作不与其他操作同 wave
  │
  │  wave 内每个 call
  ▼
ConcurrencyController  [资源层/锁层]
  │  acquire(category) → 拿锁
  │  执行工具
  │  release(category) → 释放锁 → processQueue()
  │  保证：readonly ≤5, subagent ≤3, 读写互斥
```

- **为什么两层都需要？**
  - wave 层解决：同一 batch 内读写的整体排序（宏观层面）
  - CC 层解决：跨 batch 的并发资源控制（微观层面）——wave 内若有 6 个 readonly 工具，CC 会限制只有 5 个并行
  - 单独用 CC 也能保证安全性，但会导致写操作饥饿——不断有 readonly batch 提交时，写操作可能长时间排不上
- **单工具 `execute()`**：跳过 wave 层，直接走 ConcurrencyController

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
