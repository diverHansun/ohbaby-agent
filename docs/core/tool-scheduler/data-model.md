# tool-scheduler 模块 data-model.md

本文档定义 `tool-scheduler` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 ToolCategory（工具类别）

工具根据其操作特性分为五类：

| 类别 | 说明 | 并发特性 | 示例工具 |
|------|------|----------|----------|
| readonly | 只读操作 | 可并行（最多5个） | read, glob, grep, list |
| write | 写入操作 | 串行执行 | write, edit |
| dangerous | 危险操作 | 串行执行 | bash |
| network | 网络操作 | 可并行（最多5个） | web_fetch, web_search（来自 Extension） |
| memory | 记忆操作 | 可并行（不受读写锁限制） | memory_list, memory_add, memory_update, memory_remove |

### 1.2 ToolSource（工具来源）

工具根据其来源分为四类：

| 来源 | 代码位置 | 说明 | 注册时机 |
|------|----------|------|----------|
| core | `src/tools/` | 核心工具，稳定、无外部依赖 | 启动时静态注册 |
| module | 各模块内部 | 模块内置工具，如 Memory Tools | 模块初始化时注册 |
| extension | `src/extension/tools/` | 扩展工具，依赖外部服务 | 根据配置动态加载 |
| mcp | 运行时动态 | MCP 服务器提供的工具 | 运行时发现注册 |

### 1.3 ToolCallStatus（调用状态）

工具调用的生命周期状态：

| 状态 | 说明 | 可转换到 |
|------|------|----------|
| pending | 初始状态，等待处理 | checking_policy |
| checking_policy | 正在检查策略 | queued, awaiting_approval, rejected |
| awaiting_approval | 等待用户确认 | queued, rejected, cancelled |
| queued | 已批准，等待并发资源 | executing |
| executing | 正在执行 | success, error, cancelled |
| success | 执行成功（终态） | - |
| error | 执行失败（终态） | - |
| rejected | 被拒绝（终态） | - |
| cancelled | 被取消（终态） | - |

### 1.4 ToolCall（工具调用）

表示一次工具调用的完整信息。

### 1.5 ToolCallRequest（调用请求）

来自 Agent/LLM 的工具调用请求。

### 1.6 ToolCallResult（调用结果）

工具执行完成后的结果。

---

## 二、Data Types（数据类型）

### 2.1 枚举类型

```typescript
// 工具类别
type ToolCategory = 'readonly' | 'write' | 'dangerous' | 'network' | 'memory'

// 工具来源
type ToolSource = 'core' | 'module' | 'extension' | 'mcp'

// 调用状态
type ToolCallStatus =
  | 'pending'
  | 'checking_policy'
  | 'awaiting_approval'
  | 'queued'
  | 'executing'
  | 'success'
  | 'error'
  | 'rejected'
  | 'cancelled'

// 终态状态
type FinalStatus = 'success' | 'error' | 'rejected' | 'cancelled'
```

### 2.2 请求类型

```typescript
// 工具调用请求（来自 Agent）
interface ToolCallRequest {
  callId: string                    // 调用唯一标识
  toolName: string                  // 工具名称
  params: Record<string, unknown>   // 工具参数
  sessionId: string                 // 所属会话
  messageId: string                 // 关联消息
}

// 批量调用请求
interface BatchToolCallRequest {
  calls: ToolCallRequest[]
}
```

### 2.3 调用状态类型

```typescript
// 工具调用完整状态
interface ToolCall {
  // 基础信息
  callId: string
  toolName: string
  params: Record<string, unknown>
  sessionId: string
  messageId: string

  // 状态信息
  status: ToolCallStatus
  category: ToolCategory

  // 时间信息
  createdAt: number
  startedAt?: number
  completedAt?: number

  // 结果信息（执行完成后）
  result?: ToolCallResult
  error?: ToolCallError
}

// 等待中的调用（在队列中）
interface QueuedCall {
  call: ToolCall
  resolve: (result: ToolCallResult) => void
  reject: (error: Error) => void
}
```

### 2.4 结果类型

```typescript
// 调用结果
interface ToolCallResult {
  callId: string
  status: 'success' | 'error' | 'rejected' | 'cancelled'
  output?: string                   // 工具输出
  metadata?: Record<string, unknown> // 元数据
  error?: ToolCallError             // 错误信息
  duration?: number                 // 执行时长（毫秒）
}

// 错误信息
interface ToolCallError {
  type: ToolCallErrorType
  message: string
  details?: unknown
}

// 错误类型
type ToolCallErrorType =
  | 'ToolNotFoundError'
  | 'PolicyDeniedError'
  | 'PermissionRejectedError'
  | 'ExecutionError'
  | 'TimeoutError'
  | 'CancelledError'
  | 'ValidationError'
```

### 2.5 事件类型

```typescript
// 状态变化事件
interface StatusChangedEvent {
  callId: string
  toolName: string
  previousStatus: ToolCallStatus
  currentStatus: ToolCallStatus
  timestamp: number
}

// 执行开始事件
interface ExecutionStartedEvent {
  callId: string
  toolName: string
  params: Record<string, unknown>
  timestamp: number
}

// 执行完成事件
interface ExecutionCompletedEvent {
  callId: string
  toolName: string
  result: ToolCallResult
  timestamp: number
}
```

### 2.6 配置类型

```typescript
// 并发配置
interface ConcurrencyConfig {
  maxReadConcurrency: number    // 默认 5
}

// 超时配置
interface TimeoutConfig {
  defaultTimeout: number        // 默认 120000 (2分钟)
}

// ToolScheduler 配置
interface ToolSchedulerConfig {
  concurrency: ConcurrencyConfig
  timeout: TimeoutConfig
}
```

---

## 三、Category Mapping（类别映射）

### 3.1 Core Tools 类别映射

Core Tools 来自 `src/tools/`，启动时静态注册：

```typescript
const CORE_TOOL_CATEGORIES: Record<string, ToolCategory> = {
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
}
```

### 3.2 Module-Owned Tools 类别映射

模块内置工具在模块初始化时注册：

```typescript
// Memory 模块注册的工具
const MEMORY_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  'memory_list': 'memory',
  'memory_add': 'memory',
  'memory_update': 'memory',
  'memory_remove': 'memory',
}
```

### 3.3 Extension Tools 类别映射

Extension Tools 来自 `src/extension/tools/`，根据配置动态加载：

```typescript
// Extension 模块注册的工具
const EXTENSION_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  'web_fetch': 'network',
  'web_search': 'network',
}
```

**注意**：Extension Tools 需要用户配置 Provider 和 API Key 才能使用。

### 3.4 模式与类别的映射

```typescript
// 各模式允许的工具类别
const MODE_ALLOWED_CATEGORIES: Record<Mode, ToolCategory[]> = {
  'ask': ['readonly', 'network', 'memory'],
  'plan': ['readonly', 'network', 'memory'],
  'agent': ['readonly', 'write', 'dangerous', 'network', 'memory'],
}
```

---

## 四、State Machine（状态机定义）

### 4.1 状态转换表

| 当前状态 | 事件 | 目标状态 | 条件 |
|----------|------|----------|------|
| pending | start | checking_policy | - |
| checking_policy | policy_allow | queued | 并发检查通过 |
| checking_policy | policy_allow | queued | 并发检查需等待 |
| checking_policy | policy_deny | rejected | - |
| checking_policy | policy_ask | awaiting_approval | - |
| awaiting_approval | user_approve | queued | - |
| awaiting_approval | user_reject | rejected | - |
| awaiting_approval | cancel | cancelled | - |
| queued | resource_available | executing | - |
| queued | cancel | cancelled | - |
| executing | complete | success | 执行成功 |
| executing | fail | error | 执行失败 |
| executing | cancel | cancelled | - |
| executing | timeout | error | 超时 |

### 4.2 状态转换函数

```typescript
function transition(
  current: ToolCallStatus,
  event: TransitionEvent
): ToolCallStatus | null {
  const transitions: Record<ToolCallStatus, Partial<Record<TransitionEvent, ToolCallStatus>>> = {
    'pending': {
      'start': 'checking_policy',
    },
    'checking_policy': {
      'policy_allow': 'queued',
      'policy_deny': 'rejected',
      'policy_ask': 'awaiting_approval',
    },
    'awaiting_approval': {
      'user_approve': 'queued',
      'user_reject': 'rejected',
      'cancel': 'cancelled',
    },
    'queued': {
      'resource_available': 'executing',
      'cancel': 'cancelled',
    },
    'executing': {
      'complete': 'success',
      'fail': 'error',
      'cancel': 'cancelled',
      'timeout': 'error',
    },
    // 终态无转换
    'success': {},
    'error': {},
    'rejected': {},
    'cancelled': {},
  }

  return transitions[current]?.[event] ?? null
}
```

---

## 五、Concurrency State（并发状态）

### 5.1 并发状态类型

```typescript
interface ConcurrencyState {
  readingCount: number      // 当前读操作数量
  writeInProgress: boolean  // 是否有写操作进行中
  pendingQueue: QueuedCall[] // 等待队列
}
```

### 5.2 并发决策逻辑

```typescript
function canExecute(category: ToolCategory, state: ConcurrencyState): boolean {
  // memory 类别：始终可并行执行，不受读写锁限制
  if (category === 'memory') {
    return true
  }

  const isReadLike = category === 'readonly' || category === 'network'

  if (isReadLike) {
    // 读操作：无写操作且未达并发上限
    return !state.writeInProgress && state.readingCount < 5
  } else {
    // 写操作：无任何操作进行中
    return !state.writeInProgress && state.readingCount === 0
  }
}
```

---

## 六、Constants（常量定义）

### 6.1 默认配置

```typescript
const DEFAULT_CONFIG: ToolSchedulerConfig = {
  concurrency: {
    maxReadConcurrency: 5,
  },
  timeout: {
    defaultTimeout: 120000,  // 2 分钟
  },
}
```

### 6.2 终态集合

```typescript
const FINAL_STATUSES: ToolCallStatus[] = [
  'success',
  'error',
  'rejected',
  'cancelled',
]

function isFinalStatus(status: ToolCallStatus): boolean {
  return FINAL_STATUSES.includes(status)
}
```

---

## 七、Validation Rules（验证规则）

### 7.1 请求验证

- callId: 必须非空且唯一
- toolName: 必须是已注册的工具
- params: 必须符合工具的参数 Schema
- sessionId: 必须非空
- messageId: 必须非空

### 7.2 状态转换验证

- 只允许定义的状态转换
- 终态不可再转换
- 转换前检查前置条件

---

## 八、文档自检

- [x] 核心概念定义清晰，无歧义
- [x] 数据类型完整覆盖模块需求
- [x] 状态机定义完整
- [x] 并发控制逻辑清晰
- [x] 类型定义符合 TypeScript 规范
