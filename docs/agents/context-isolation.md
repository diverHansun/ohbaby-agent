# agents 模块 context-isolation.md

本文档描述主代理与子代理之间的上下文隔离机制设计。

---

## 一、设计概述

ohbaby-agent 采用**逻辑隔离**策略，在同一进程内通过 Session 分离实现主代理与子代理的上下文隔离。子代理不继承父代理的 Memory 和历史消息，消息流完全隔离，仅通过 `SubtaskPart` 传递任务结果。

### 核心设计决策

| 决策项 | 确认值 | 说明 |
|--------|--------|------|
| 隔离方式 | **逻辑隔离** | 同一进程内，通过 Session 分离实现 |
| Memory 继承 | **不继承** | 子代理永不继承父代理的 Memory |
| 主代理 maxSteps | **100** | 支持更复杂任务 |
| 子代理 maxSteps | **60** | 子代理任务也可能较复杂 |
| 子代理 timeout | **10 分钟** | 确保复杂任务有足够执行时间 |
| 并发子代理数 | **6** | 提高并行能力 |
| 批量终止触发 | **双击 Ctrl+C** | 单击中断主代理，双击中断所有 |
| 消息流隔离 | **完全隔离** | 通过 SubtaskPart 传递结果 |

---

## 二、上下文隔离架构

### 2.1 主代理与子代理上下文对比

```
┌─────────────────────────────────────────────────────────────────┐
│                       主代理上下文                               │
├─────────────────────────────────────────────────────────────────┤
│ SystemPrompt                                                     │
│ ├── Identity（主代理身份定义）                                   │
│ ├── Environment（完整环境信息）                                  │
│ └── CustomInstructions（用户自定义指令）                         │
│                                                                  │
│ Memory                                                           │
│ ├── 全局 OHBABY.md                                                 │
│ └── 项目级 OHBABY.md                                               │
│                                                                  │
│ 历史消息                                                         │
│ ├── 压缩后的 Summary（如有）                                     │
│ └── 保留的近期消息                                               │
│                                                                  │
│ 用户消息                                                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       子代理上下文                               │
├─────────────────────────────────────────────────────────────────┤
│ SystemPrompt                                                     │
│ ├── AgentPrompt（子代理专属提示词，如 explore/research）         │
│ └── Environment（精简版环境信息）                                │
│                                                                  │
│ Memory                                                           │
│ └── （空）← 不继承父代理 Memory                                  │
│                                                                  │
│ 历史消息                                                         │
│ └── 子 Session 自己的消息 ← 不继承父代理历史                     │
│                                                                  │
│ 任务 Prompt                                                      │
│ └── 来自 task 工具的 prompt 参数                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 通信机制：SubtaskPart

主代理与子代理的唯一通信点是 `SubtaskPart`：

```
父 Session（主代理）
│
├── AssistantMessage
│   ├── TextPart: "我将使用 explore 代理搜索文件..."
│   │
│   ├── SubtaskPart ────────────────────────────────────┐
│   │   ├── agent: 'explore'                            │
│   │   ├── prompt: '搜索所有 TypeScript 文件'          │
│   │   ├── childSessionId: 'session_child_xxx' ────────│───┐
│   │   ├── status: 'completed'                         │   │
│   │   └── result: '找到 15 个文件...' ◄───── 结果传回 ─┘   │
│   │                                                       │
│   └── TextPart: "基于搜索结果，我建议..."                 │
│                                                           │
└───────────────────────────────────────────────────────────│───┐
                                                            │   │
子 Session（子代理）◄───────────────────────────────────────┘   │
│                                                               │
├── UserMessage: { prompt: '搜索所有 TypeScript 文件' }         │
│   └── TextPart: '搜索所有 TypeScript 文件'                    │
│                                                               │
└── AssistantMessage: { agent: 'explore' }                      │
    ├── ToolPart: Glob 调用                                     │
    ├── ToolPart: Read 调用                                     │
    └── TextPart: '找到 15 个文件...' ──────────────────────────┘
                         │
                         └── 最终输出传递给 SubtaskPart.result
```

---

## 三、中断机制

### 3.1 单击 vs 双击 Ctrl+C

```
┌─────────────────────────────────────────────────────────────────┐
│ 单击 Ctrl+C（第一次）                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  行为：                                                         │
│  1. 只中断主代理当前的 LLM 调用                                 │
│  2. 子代理继续运行                                              │
│  3. 显示提示：                                                  │
│     "已中断当前操作。再次按 Ctrl+C 可终止所有子代理任务。"       │
│                                                                 │
│  用途：                                                         │
│  - 取消当前操作，但保留子代理任务继续执行                       │
│  - 避免误操作导致长时间任务丢失                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 双击 Ctrl+C（500ms 内按两次）                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  行为：                                                         │
│  1. 中断主代理执行                                              │
│  2. 调用 SubagentExecutor.terminateAll(mainSessionId)          │
│  3. 所有子代理的 SubtaskPart 标记为：                           │
│     - status: 'aborted'                                        │
│     - terminationReason: 'aborted_by_user'                     │
│  4. 显示提示："已终止所有任务"                                  │
│                                                                 │
│  用途：                                                         │
│  - 紧急停止所有操作                                             │
│  - 完全重置执行状态                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 主代理主动终止子代理

主代理正常情况下应等待子代理返回结果，但可以主动终止：

```
触发方式：
├── 主代理返回新的工具调用，覆盖/取消之前的子代理任务
└── 或通过 SubagentExecutor.terminate(childSessionId)

处理流程：
├── 子代理的 AbortController.abort() 被调用
├── 子代理 Lifecycle 响应 abort，清理状态
└── SubtaskPart 更新为：
    status: 'aborted'
    terminationReason: 'aborted_by_parent'
```

### 3.3 子代理超时处理

子代理执行超过 10 分钟时自动终止：

```
超时流程：
├── SubagentExecutor 检测到执行时间 >= 10 分钟
├── 触发子代理的 AbortController.abort()
├── 子代理 Lifecycle 清理状态
├── SubtaskPart 更新为：
│   status: 'timeout'
│   terminationReason: 'timeout'
│   error: 'Subagent execution timed out after 10 minutes'
└── 主代理继续执行（收到超时状态，由 LLM 决定后续处理）

关键：超时不阻塞主代理的整体流程
```

---

## 四、数据结构

### 4.1 SubtaskPart（增强版）

```typescript
interface SubtaskPart extends PartBase {
  type: 'subtask'
  
  // ===== 任务定义 =====
  prompt: string                // 子任务提示词
  description: string           // 子任务描述（UI 显示用）
  agent: string                 // 子代理名称
  
  // ===== 会话关联 =====
  childSessionId: string        // 子代理独立 Session
  
  // ===== 执行状态 =====
  status: SubtaskStatus         // pending | running | completed | failed | aborted | timeout
  
  // ===== 结果传递（核心通信点） =====
  result?: string               // 子代理的最终输出（成功时）
  error?: string                // 错误信息（失败时）
  
  // ===== 时间与统计 =====
  time: {
    start: number
    end?: number
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
```

### 4.2 Session（增强版）

```typescript
interface Session {
  // ... 其他字段 ...
  
  // ===== 父子关系（子代理支持） =====
  parentId?: string             // 父会话 ID（子代理会话必填）
  childrenIds?: string[]        // 子会话 ID 列表
  isSubagent: boolean           // 是否为子代理会话（显式标记）
}
```

---

## 五、接口汇总

### 5.1 SubagentExecutor 接口

```typescript
namespace SubagentExecutor {
  /** 执行子代理任务 */
  function execute(params: SubagentExecuteParams): Promise<SubagentResult>

  /** 检查子代理是否正在运行 */
  function isRunning(sessionId: string): boolean

  /** 获取当前并发数 */
  function getConcurrentCount(): number

  /** 终止单个子代理 */
  function terminate(
    sessionId: string,
    reason?: 'aborted_by_user' | 'aborted_by_parent' | 'timeout'
  ): Promise<void>

  /** 终止指定父 Session 的所有子代理（双击 Ctrl+C 触发） */
  function terminateAll(parentSessionId: string): Promise<void>

  /** 获取指定父 Session 的所有运行中子代理 */
  function getRunningChildren(parentSessionId: string): string[]
}
```

### 5.2 Context.assemble() 接口

```typescript
/**
 * 组装上下文
 * 
 * @param sessionId - 会话 ID
 * @param directory - 当前工作目录
 * @param isSubagent - 是否为子代理模式（默认 false）
 * 
 * 子代理模式下：
 * - 不加载 Memory
 * - 不继承父 Session 的历史
 * - 使用子代理专属的 SystemPrompt
 */
async function assemble(
  sessionId: string,
  directory: string,
  isSubagent: boolean = false
): Promise<AssembledContext>
```

### 5.3 Lifecycle.run() 接口

```typescript
interface LifecycleRunOptions {
  sessionId: string
  request: string
  signal?: AbortSignal
  callbacks?: LoopCallbacks
  
  // ===== 子代理相关参数 =====
  parentSessionId?: string    // 父 Session ID（子代理执行时必填）
  isSubagent?: boolean        // 是否为子代理执行
}
```

### 5.4 SessionManager 接口

```typescript
namespace SessionManager {
  /** 创建会话（支持 isSubagent 参数） */
  function create(projectDirectory: string, options?: {
    title?: string
    agentName?: string
    parentId?: string
    isSubagent?: boolean
  }): Promise<Session>

  /** 获取子会话列表 */
  function getChildren(parentSessionId: string): Promise<Session[]>

  /** 判断是否为子代理会话 */
  function isSubagentSession(sessionId: string): Promise<boolean>
}
```

---

## 六、常量定义

```typescript
/** 主代理默认最大步数 */
const DEFAULT_PRIMARY_MAX_STEPS = 100

/** 子代理默认最大步数 */
const DEFAULT_SUBAGENT_MAX_STEPS = 60

/** 主代理默认超时时间（毫秒） */
const DEFAULT_PRIMARY_TIMEOUT = 600000  // 10 分钟

/** 子代理默认超时时间（毫秒） */
const DEFAULT_SUBAGENT_TIMEOUT = 600000  // 10 分钟

/** 最大并发子代理数 */
const MAX_CONCURRENT_SUBAGENTS = 6

/** 双击 Ctrl+C 的时间窗口（毫秒） */
const DOUBLE_CTRL_C_WINDOW = 500
```

---

## 七、执行流程

### 7.1 子代理执行完整流程

```
1. [tools/task.ts] 收到 LLM 的 task 工具调用
   └── 输入：agentName, prompt, description
   
2. [SubagentExecutor] 检查并发限制
   ├── 当前运行中子代理数 < 6 ?
   │   ├── Yes: 继续
   │   └── No: 抛出 MaxConcurrentExceededError
   
3. [SubagentExecutor → Session] 创建子 Session
   ├── Session.create({
   │     parentId: parentSessionId,
   │     agentName: agentName,
   │     isSubagent: true
   │   })
   └── 返回 childSession

4. [SubagentExecutor → Message] 创建 SubtaskPart
   ├── 在父 Session 的当前 AssistantMessage 中创建
   └── status: 'pending'

5. [SubagentExecutor → Lifecycle] 创建并运行子代理生命周期
   ├── Lifecycle.run({
   │     sessionId: childSession.id,
   │     parentSessionId: parentSessionId,
   │     isSubagent: true
   │   })
   │
   ├── [内部] Context.assemble(childSession.id, directory, true)
   │   └── isSubagent=true → 不加载 Memory，不继承父历史
   │
   └── 等待执行完成

6. [SubagentExecutor → Message] 更新 SubtaskPart
   ├── success:
   │   ├── status: 'completed'
   │   ├── result: 子代理最终输出
   │   └── stats: { steps, toolCalls, duration }
   │
   └── failure/abort/timeout:
       ├── status: 对应状态
       ├── error: 错误信息
       └── terminationReason: 对应原因

7. [tools/task.ts] 返回结果给主代理
   └── 返回 SubagentResult 作为工具结果
```

---

## 八、文档自检

- [x] 隔离机制设计完整，覆盖 Memory、历史、消息流
- [x] 通信机制明确，通过 SubtaskPart 传递结果
- [x] 中断机制差异化处理（单击/双击）
- [x] 超时处理确保不阻塞主流程
- [x] 接口定义完整，各模块职责清晰
- [x] 常量定义集中，便于维护
- [x] 执行流程清晰，便于实现参考
