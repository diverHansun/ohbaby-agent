# tool-scheduler 模块 architecture.md

本文档描述 `tool-scheduler` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

ToolScheduler 是 iris-code 的工具调度中心，位于 Agent 与 tools 模块之间，协调权限检查、并发控制和工具执行。

### 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        ToolScheduler                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │   ToolRegistry   │  │   StateManager   │                     │
│  │                  │  │                  │                     │
│  │  - builtinTools  │  │  - toolCalls     │                     │
│  │  - extTools      │  │  - transitions   │                     │
│  │  - mcpTools      │  │  - notify()      │                     │
│  │  - categories    │  │                  │                     │
│  └──────────────────┘  └──────────────────┘                     │
│           │                     │                                │
│           └─────────┬───────────┘                                │
│                     │                                            │
│  ┌──────────────────┴───────────────────┐                       │
│  │        ConcurrencyController          │                       │
│  │                                       │                       │
│  │  - maxReadConcurrency: 5              │                       │
│  │  - currentReadCount                   │                       │
│  │  - writeInProgress                    │                       │
│  │  - pendingQueue                       │                       │
│  │  - canExecute()                       │                       │
│  │  - acquire() / release()              │                       │
│  └───────────────────────────────────────┘                       │
│                     │                                            │
│  ┌──────────────────┴───────────────────┐                       │
│  │          ExecutionEngine              │                       │
│  │                                       │                       │
│  │  - execute()                          │                       │
│  │  - cancel()                           │                       │
│  │  - processQueue()                     │                       │
│  └───────────────────────────────────────┘                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
      ┌─────────┐       ┌──────────┐      ┌─────────┐
      │ Policy  │       │Permission│      │  tools  │
      └─────────┘       └──────────┘      └─────────┘
```

---

## 二、Core Components（核心组件）

### 2.1 ToolRegistry

**职责**：管理工具注册和查询

**数据结构**：
```typescript
class ToolRegistry {
  private builtinTools: Map<string, Tool>      // 内置工具
  private extensionTools: Map<string, Tool>    // 扩展工具
  private mcpTools: Map<string, Tool>          // MCP 工具
  private categoryMap: Map<string, ToolCategory>  // 类别映射
}
```

**主要方法**：
- `register(tool)`: 注册工具
- `get(name)`: 获取工具
- `getCategory(name)`: 获取工具类别
- `getAvailableTools(mode)`: 根据模式获取可用工具

**类别映射表**：
```typescript
const BUILTIN_CATEGORIES: Record<string, ToolCategory> = {
  // readonly
  'read': 'readonly',
  'glob': 'readonly',
  'grep': 'readonly',
  'list': 'readonly',
  'todo_read': 'readonly',

  // write
  'write': 'write',
  'edit': 'write',
  'todo_write': 'write',

  // dangerous
  'bash': 'dangerous',

  // network
  'web_fetch': 'network',
  'web_search': 'network',

  // skill
  'skill': 'skill',
}
```

### 2.2 StateManager

**职责**：管理工具调用状态

**状态定义**：
```typescript
type ToolCallStatus =
  | 'pending'           // 等待处理
  | 'checking_policy'   // 检查策略
  | 'awaiting_approval' // 等待用户确认
  | 'queued'            // 等待执行（并发控制）
  | 'executing'         // 正在执行
  | 'success'           // 执行成功
  | 'error'             // 执行失败
  | 'rejected'          // 被拒绝
  | 'cancelled'         // 被取消
```

**状态转换规则**：
```
pending
   │
   ▼
checking_policy
   │
   ├── DENY ──────────────────────────────→ rejected
   │
   ├── ALLOW ─────→ [并发检查] ─── 可执行 ──→ executing ──→ success
   │                    │                        │
   │                    └── 需等待 ──→ queued ───┘       └──→ error
   │
   └── ASK ───────→ awaiting_approval
                        │
                        ├── once/always ──→ [并发检查] ──→ ...
                        ├── reject ───────────────────────→ rejected
                        └── cancel ───────────────────────→ cancelled
```

### 2.3 ConcurrencyController

**职责**：控制工具执行的并发

**并发策略**：
- 读操作（readonly/network/skill）：最多 5 个并行
- 写操作（write/dangerous）：串行执行，且无读操作时才能执行

**核心逻辑**：
```typescript
class ConcurrencyController {
  private readingCount = 0
  private writeInProgress = false
  private pendingQueue: QueuedCall[] = []

  canExecute(category: ToolCategory): boolean {
    if (category === 'readonly' || category === 'network' || category === 'skill') {
      return !this.writeInProgress && this.readingCount < 5
    } else {
      return !this.writeInProgress && this.readingCount === 0
    }
  }

  acquire(category: ToolCategory): void {
    if (category === 'readonly' || category === 'network' || category === 'skill') {
      this.readingCount++
    } else {
      this.writeInProgress = true
    }
  }

  release(category: ToolCategory): void {
    if (category === 'readonly' || category === 'network' || category === 'skill') {
      this.readingCount--
    } else {
      this.writeInProgress = false
    }
    this.processQueue()
  }
}
```

**并发矩阵**：

| 当前状态 | readonly/network/skill | write/dangerous |
|----------|------------------------|-----------------|
| 空闲 | 允许（并发≤5） | 允许 |
| 有读操作 | 允许（并发≤5） | 排队等待 |
| 有写操作 | 排队等待 | 排队等待 |

### 2.4 ExecutionEngine

**职责**：执行工具调用

**执行流程**：
1. 检查工具是否存在
2. 创建 ToolCall 对象，状态设为 pending
3. 调用 Policy.check() 获取决策
4. 根据决策处理
5. 通过 ConcurrencyController 检查是否可执行
6. 执行工具或加入队列
7. 返回结果

---

## 三、Design Patterns（设计模式）

### 3.1 状态机模式（State Machine）

**应用场景**：工具调用状态管理

**实现方式**：
- 明确的状态枚举
- 显式的状态转换规则
- 每次转换通过 transition() 方法

**选择理由**：
- 工具调用有明确的生命周期
- 状态转换需要可追踪
- 便于调试和监控

### 3.2 队列模式（Queue Pattern）

**应用场景**：并发控制和任务排队

**实现方式**：
- pendingQueue 存储等待执行的调用
- processQueue() 在资源释放时处理队列

**选择理由**：
- 写操作需要等待读操作完成
- 保证公平调度

### 3.3 观察者模式（Observer Pattern）

**应用场景**：状态变化通知

**实现方式**：
- 通过 Bus 发布状态变化事件
- UI 和其他模块订阅事件

**选择理由**：
- 解耦状态管理和 UI 更新
- 支持多个订阅者

---

## 四、Integration Points（集成点）

### 4.1 与 Policy 集成

```typescript
// 获取当前模式
const mode = Policy.getMode()

// 检查工具执行决策
const decision = Policy.check(category)
// decision: 'allow' | 'deny' | 'ask'
```

### 4.2 与 Permission 集成

```typescript
// 当 Policy 返回 'ask' 时
try {
  await Permission.ask({
    sessionId,
    messageId,
    type: 'tool',
    name: toolName,
    title: `Execute ${toolName}`,
    metadata: { params }
  })
  // 用户批准，继续执行
} catch (error) {
  if (error instanceof Permission.RejectedError) {
    // 用户拒绝
  }
}
```

### 4.3 与 tools 模块集成

```typescript
// 执行工具
const result = await tool.execute(params, {
  sessionId,
  messageId,
  callId,
  signal
})
```

---

## 五、Event Design（事件设计）

### 5.1 发布的事件

| 事件名称 | 触发时机 | 携带数据 |
|----------|----------|----------|
| ToolScheduler.Event.StatusChanged | 状态变化时 | callId, previousStatus, currentStatus, toolName |
| ToolScheduler.Event.ExecutionStarted | 开始执行时 | callId, toolName, params |
| ToolScheduler.Event.ExecutionCompleted | 执行完成时 | callId, toolName, result |

### 5.2 订阅的事件

| 事件名称 | 来源 | 处理逻辑 |
|----------|------|----------|
| Permission.Event.Replied | Permission | 处理用户确认响应 |

---

## 六、Error Handling（错误处理）

### 6.1 错误类型

| 错误类型 | 场景 | 处理方式 |
|----------|------|----------|
| ToolNotFoundError | 工具不存在 | 返回错误，状态设为 error |
| PolicyDeniedError | Policy 返回 deny | 状态设为 rejected |
| PermissionRejectedError | 用户拒绝 | 状态设为 rejected |
| ExecutionError | 工具执行失败 | 状态设为 error |
| TimeoutError | 执行超时 | 终止执行，状态设为 error |
| CancelledError | 被取消 | 状态设为 cancelled |

### 6.2 错误恢复

- 单个工具失败不影响其他工具
- 释放并发锁，处理队列中下一个
- 通过事件通知状态变化

---

## 七、Timeout Management（超时管理）

### 7.1 默认超时

- 工具执行：2 分钟
- Permission 等待：无超时（由 Agent 控制）

### 7.2 超时处理

```typescript
// 创建带超时的 AbortController
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 120000)

try {
  await tool.execute(params, { ...context, signal: controller.signal })
} finally {
  clearTimeout(timeout)
}
```

---

## 八、Dependencies（依赖关系）

### 8.1 外部依赖

| 依赖模块 | 依赖方式 | 用途 |
|----------|----------|------|
| Policy | 运行时依赖 | 获取模式和决策 |
| Permission | 运行时依赖 | 用户确认 |
| Bus | 运行时依赖 | 事件发布/订阅 |
| tools | 运行时依赖 | 工具实现 |

### 8.2 被依赖

| 依赖方 | 调用接口 | 用途 |
|--------|----------|------|
| Agent | execute(), getAvailableTools() | 工具调用和工具列表 |

---

## 九、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 组件职责单一，边界清晰
- [x] 设计模式选择有明确理由
- [x] 并发控制策略清晰
- [x] 状态机转换规则完整
- [x] 错误处理策略明确
