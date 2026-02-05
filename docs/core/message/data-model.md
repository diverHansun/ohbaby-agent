# message 模块 data-model.md

本文档定义 `message` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: Message（消息）

**定义**：Message 是对话中用户或助手发送的一条消息的元数据容器，不包含具体内容（内容存储在 Part 中）。

**分类**：
- `UserMessage`：用户发送的消息
- `AssistantMessage`：助手（LLM）生成的消息

**特点**：
- Message 只存储元数据（角色、时间、模型信息等）
- 具体内容（文本、工具调用等）存储在关联的 Part 中
- 一个 Message 可以有多个 Part

### 概念 2: Part（消息组成部分）

**定义**：Part 是 Message 的内容组成单元，代表消息中的一个独立内容块（文本、工具调用、推理等）。

**特点**：
- Part 独立存储，支持流式增量更新
- 每个 Part 属于且仅属于一个 Message
- Part 类型多样，支持不同内容形式

### 概念 3: MessageWithParts（消息及其内容）

**定义**：Message 和其关联 Part 的组合体，用于对外返回完整消息。

```
MessageWithParts = {
  info: Message           // 消息元数据
  parts: Part[]           // 消息内容列表
}
```

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|------|------|------|
| Message | Entity（实体） | 有唯一标识（messageId），有生命周期 |
| Part | Entity（实体） | 有唯一标识（partId），可独立更新 |
| TokenStats | Value Object（值对象） | 嵌入在 Part 中，无独立身份 |
| ToolState | Value Object（值对象） | 嵌入在 ToolPart 中，描述状态 |

---

## 三、Message 类型定义

### 3.1 UserMessage（用户消息）

```typescript
interface UserMessage {
  // ======== 标识 ========
  id: string                    // 格式: message_<timestamp>_<random>
  sessionId: string             // 所属会话 ID
  role: 'user'                  // 角色标识
  
  // ======== 时间 ========
  time: {
    created: number             // 创建时间戳（毫秒）
  }
  
  // ======== 上下文 ========
  agent: string                 // 使用的 Agent 名称
  model: {
    providerId: string          // LLM 提供商 ID
    modelId: string             // LLM 模型 ID
  }
  
  // ======== 可选配置 ========
  system?: string               // 额外的系统提示（覆盖默认）
  tools?: Record<string, boolean>  // 启用/禁用的工具
}
```

### 3.2 AssistantMessage（助手消息）

```typescript
interface AssistantMessage {
  // ======== 标识 ========
  id: string                    // 格式: message_<timestamp>_<random>
  sessionId: string             // 所属会话 ID
  role: 'assistant'             // 角色标识
  parentId: string              // 关联的 UserMessage ID
  
  // ======== 时间 ========
  time: {
    created: number             // 创建时间戳
    completed?: number          // 完成时间戳（可选）
  }
  
  // ======== 执行上下文 ========
  agent: string                 // Agent 名称
  providerId: string            // LLM 提供商 ID
  modelId: string               // LLM 模型 ID
  path: {
    cwd: string                 // 当前工作目录
    root: string                // 项目根目录
  }
  
  // ======== Token 统计 ========
  tokens: {
    input: number               // 输入 token 数
    output: number              // 输出 token 数
    reasoning: number           // 推理 token 数
    cache: {
      read: number              // 缓存命中 token 数
      write: number             // 缓存写入 token 数
    }
  }
  cost: number                  // 费用（美元）
  
  // ======== 结束状态 ========
  finish?: string               // 结束原因: stop | tool-calls | length | ...
  error?: MessageError          // 错误信息（如有）
  
  // ======== 压缩标识 ========
  summary?: boolean             // 是否为压缩摘要消息（由 Context 模块创建）
}


type MessageError = 
  | { name: 'ProviderAuthError'; providerID: string; message: string }
  | { name: 'MessageOutputLengthError' }
  | { name: 'MessageAbortedError'; message: string }
  | { name: 'APIError'; message: string; statusCode?: number; isRetryable: boolean }
  | { name: 'Unknown'; message: string }
```

### 3.3 SystemMessage（系统消息）

```typescript
interface SystemMessage {
  // ======== 标识 ========
  id: string                    // 格式: message_<timestamp>_<random>
  sessionId: string             // 所属会话 ID
  role: 'system'                // 角色标识
  
  // ======== 时间 ========
  time: {
    created: number             // 创建时间戳（毫秒）
  }
  
  // ======== 系统消息类型 ========
  kind: SystemMessageKind       // 系统消息类型
}

type SystemMessageKind = 
  | 'abort'                     // 用户中断执行
  | 'error'                     // 系统错误
  | 'info'                      // 信息提示
```

**用途**：
- `abort`：用户按 Ctrl+C 中断执行时创建，记录中断事件
- `error`：系统级错误（非工具执行错误）
- `info`：系统级信息提示（预留）

### 3.4 Message（联合类型）

```typescript
type Message = UserMessage | AssistantMessage | SystemMessage
```

---

## 四、Part 类型定义

### 4.1 Part 基础字段

```typescript
interface PartBase {
  id: string                    // 格式: part_<timestamp>_<random>
  messageId: string             // 所属消息 ID
  sessionId: string             // 所属会话 ID
}
```

### 4.2 TextPart（文本内容）

```typescript
interface TextPart extends PartBase {
  type: 'text'
  text: string                  // 文本内容
  synthetic?: boolean           // 是否为合成消息（系统生成）
  ignored?: boolean             // 是否在发送给 LLM 时忽略
  time?: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>  // 提供商元数据
}
```

### 4.3 ReasoningPart（推理内容）

```typescript
interface ReasoningPart extends PartBase {
  type: 'reasoning'
  text: string                  // 推理内容
  time: {
    start: number
    end?: number
  }
  metadata?: Record<string, unknown>
}
```

### 4.4 ToolPart（工具调用）

```typescript
interface ToolPart extends PartBase {
  type: 'tool'
  callId: string                // 工具调用 ID
  tool: string                  // 工具名称
  state: ToolState              // 工具状态
  metadata?: Record<string, unknown>
}

// 工具状态（状态机）
type ToolState = 
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError
  | ToolStateAborted

interface ToolStatePending {
  status: 'pending'
  input: Record<string, unknown>  // 工具参数
  raw: string                     // 原始参数字符串
}

interface ToolStateRunning {
  status: 'running'
  input: Record<string, unknown>
  title?: string                  // 显示标题
  metadata?: Record<string, unknown>
  time: { start: number }
}

interface ToolStateCompleted {
  status: 'completed'
  input: Record<string, unknown>
  output: string                  // 工具输出
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number; compacted?: number }
  attachments?: FilePart[]        // 附件
}

interface ToolStateError {
  status: 'error'
  input: Record<string, unknown>
  error: string                   // 错误信息
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
}

interface ToolStateAborted {
  status: 'aborted'               // 用户中断
  input: Record<string, unknown>
  error: 'Tool execution aborted by user'  // 固定错误消息
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
}
```

### 4.5 FilePart（文件附件）

```typescript
interface FilePart extends PartBase {
  type: 'file'
  mime: string                  // MIME 类型
  filename?: string             // 文件名
  url: string                   // 文件 URL（file:// 或 data:）
  source?: FilePartSource       // 来源信息
}
```

### 4.6 StepStartPart（Step 开始）

```typescript
interface StepStartPart extends PartBase {
  type: 'step-start'
  snapshot?: string             // 文件系统快照 ID
}
```

### 4.7 StepFinishPart（Step 结束）

```typescript
interface StepFinishPart extends PartBase {
  type: 'step-finish'
  reason: string                // 结束原因
  snapshot?: string             // 文件系统快照 ID
  cost: number                  // 本步费用
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}
```

### 4.8 预留 Part 类型（MVP 不实现）

```typescript
// SnapshotPart - 文件系统快照
interface SnapshotPart extends PartBase {
  type: 'snapshot'
  snapshot: string
}

// PatchPart - 文件变更记录
interface PatchPart extends PartBase {
  type: 'patch'
  hash: string
  files: string[]
}

// CompactionPart - 上下文压缩标记
interface CompactionPart extends PartBase {
  type: 'compaction'
  auto: boolean
}

// SubtaskPart - 子任务标记（子代理执行记录）
// 这是主代理与子代理的唯一通信点，消息流完全隔离
interface SubtaskPart extends PartBase {
  type: 'subtask'
  
  // ===== 任务定义 =====
  prompt: string                // 子任务提示词
  description: string           // 子任务描述（用于 UI 显示）
  agent: string                 // 子代理名称（explore / research 等）
  
  // ===== 会话关联 =====
  childSessionId: string        // 子会话 ID，关联到 Session 模块
  
  // ===== 执行状态 =====
  status: SubtaskStatus         // 执行状态
  
  // ===== 结果传递（核心通信点） =====
  result?: string               // 子代理的最终输出（completed 时填充）
  error?: string                // 错误信息（failed/aborted/timeout 时填充）
  
  // ===== 时间与统计 =====
  time: {
    start: number               // 开始时间
    end?: number                // 结束时间
  }
  stats?: {
    steps: number               // 执行步数
    toolCalls: number           // 工具调用次数
    duration: number            // 耗时（毫秒）
  }
  
  // ===== 终止原因 =====
  terminationReason?: SubtaskTerminationReason
}

type SubtaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'timeout'

type SubtaskTerminationReason = 
  | 'completed'             // 正常完成
  | 'failed'                // 执行失败
  | 'aborted_by_user'       // 用户双击 Ctrl+C
  | 'aborted_by_parent'     // 主代理主动终止
  | 'timeout'               // 超时（10 分钟）

// AgentPart - Agent 引用
interface AgentPart extends PartBase {
  type: 'agent'
  name: string
  source?: { value: string; start: number; end: number }
}

// RetryPart - 重试标记
interface RetryPart extends PartBase {
  type: 'retry'
  attempt: number
  error: MessageError
  time: { created: number }
}
```

### 4.9 Part（联合类型）

```typescript
type Part = 
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | CompactionPart
  | SubtaskPart
  | AgentPart
  | RetryPart
```

---

## 五、Event 类型定义

```typescript
namespace MessageEvent {
  // 消息更新事件
  interface Updated {
    type: 'message.updated'
    info: Message
  }
  
  // 消息删除事件
  interface Removed {
    type: 'message.removed'
    sessionId: string
    messageId: string
  }
  
  // Part 更新事件
  interface PartUpdated {
    type: 'message.part.updated'
    part: Part
    delta?: string              // 增量内容（用于流式更新）
  }
  
  // Part 删除事件
  interface PartRemoved {
    type: 'message.part.removed'
    sessionId: string
    messageId: string
    partId: string
  }
}
```

---

## 六、ID 生成规则

### messageId 生成

```typescript
function generateMessageId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `message_${timestamp}_${random}`
}

// 示例: message_1703577600000_a1b2c3
```

### partId 生成

```typescript
function generatePartId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `part_${timestamp}_${random}`
}

// 示例: part_1703577600000_x9y8z7
```

**特点**：
- 包含时间戳，天然有序
- 包含随机部分，避免冲突
- 可读性好，便于调试

---

## 七、Agent 与 Message 的交互关系

### 7.1 消息级别的 Agent 标识

每条消息都记录了执行时使用的 Agent：

```
UserMessage.agent: string       // 请求时指定的 Agent（如 'build'）
AssistantMessage.agent: string  // 响应时使用的 Agent
```

**用途**：
- 记录对话历史中使用的 Agent
- 支持会话中动态切换 Agent
- 子代理消息使用子代理名称（如 'explore'）

### 7.2 SubtaskPart 与子代理执行

当主代理调用 SubagentExecutor 创建子代理时，会在父会话消息中创建 SubtaskPart：

```
父会话 AssistantMessage
  |-- TextPart: "我将使用 explore 代理搜索文件..."
  |-- SubtaskPart: {
  |     agent: 'explore',
  |     childSessionId: 'session_xxx',
  |     status: 'running' -> 'completed',
  |     result: '找到 5 个匹配文件'
  |   }
  +-- TextPart: "搜索完成，以下是结果..."
```

子会话消息流独立存储：

```
子会话 (session_xxx)
  |-- UserMessage: { agent: 'explore', ... }
  |   +-- TextPart: 子任务 prompt
  +-- AssistantMessage: { agent: 'explore', ... }
      |-- ToolPart: Glob 调用
      +-- TextPart: 执行结果
```

### 7.3 主代理与子代理消息的关系

```
主会话 (session_main)
|
|-- UserMessage (user: "帮我重构这个模块")
|-- AssistantMessage (agent: 'build')
|   |-- TextPart: "首先让我了解代码结构..."
|   |-- SubtaskPart: { agent: 'explore', childSessionId: 'session_child_1' }
|   +-- TextPart: "基于分析结果，我将..."
|
+-- Session.childrenIds: ['session_child_1']

子会话 (session_child_1)
|
|-- UserMessage (agent: 'explore')
|-- AssistantMessage (agent: 'explore')
|
+-- Session.parentId: 'session_main'
```

---

## 八、Lifecycle & Ownership（生命周期与归属）

### Message 生命周期

```
创建（updateMessage）
    │
    ├── 生成 messageId
    ├── 设置 role、time.created
    ├── 关联到 sessionId
    │
    ▼
使用中
    │
    ├── 关联的 Part 被创建和更新
    ├── 流式响应期间不断更新
    │
    ▼
完成（updateMessage with time.completed）
    │
    └── 设置 finish、error（如有）

删除（removeMessage）
    │
    └── 同时删除所有关联的 Part
```

### Part 生命周期

```
创建（updatePart）
    │
    ├── 生成 partId
    ├── 关联到 messageId 和 sessionId
    │
    ▼
使用中
    │
    ├── 可被多次更新（如流式文本追加）
    ├── ToolPart 状态变化：pending -> running -> completed/error
    │
    ▼
删除（removePart 或随 Message 删除）
```

### 数据归属

| 数据 | 创建者 | 管理者 | 说明 |
|------|--------|--------|------|
| Message | lifecycle | MessageManager | lifecycle 调用接口创建 |
| Part | lifecycle | MessageManager | lifecycle 调用接口创建 |
| messageId | MessageManager | MessageManager | 由工厂函数生成 |
| partId | MessageManager | MessageManager | 由工厂函数生成 |

---

## 八、数据不变性约束

| 字段 | 可变性 | 说明 |
|------|--------|------|
| Message.id | 不可变 | 创建后永不改变 |
| Message.sessionId | 不可变 | 创建后永不改变 |
| Message.role | 不可变 | 创建后永不改变 |
| Message.time.created | 不可变 | 记录创建时间 |
| Message.time.completed | 可变 | 完成时设置 |
| Message.tokens | 可变 | 可累加更新 |
| Message.finish | 可变 | 完成时设置 |
| Message.error | 可变 | 错误时设置 |
| Part.id | 不可变 | 创建后永不改变 |
| Part.messageId | 不可变 | 创建后永不改变 |
| Part.type | 不可变 | 创建后永不改变 |
| Part 内容字段 | 可变 | 支持流式更新 |

---

## 九、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 不存在"为了设计而设计"的抽象
- [x] 所有概念在后续接口和数据流中都有使用场景
- [x] ID 生成规则清晰且稳定
- [x] 数据生命周期和归属明确
- [x] Part 类型完整对齐 opencode
- [x] Agent 与 Message 的交互关系明确
- [x] SubtaskPart 与子会话的关联设计清晰
- [x] SystemMessage 支持记录系统事件（如用户中断）
- [x] ToolStateAborted 支持区分用户中断和执行错误
