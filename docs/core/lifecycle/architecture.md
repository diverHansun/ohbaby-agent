# lifecycle 模块 architecture.md

本文档描述 `lifecycle` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

lifecycle 模块采用**双层循环架构**，将职责分离为两个层次：

```
┌─────────────────────────────────────────────────────────────────┐
│ Lifecycle（外层循环）                                            │
│                                                                  │
│ 职责：                                                           │
│ - 管理多步推理的整体流程                                          │
│ - 检查退出条件（maxSteps、abort、完成）                            │
│ - 维护执行状态（步数、统计信息）                                    │
│ - 并发控制（防止同一 session 重复执行）                             │
│                                                                  │
│   while (shouldContinue) {                                       │
│     ┌─────────────────────────────────────────────────────┐      │
│     │ TurnProcessor（内层处理器）                           │      │
│     │                                                      │      │
│     │ 职责：                                               │      │
│     │ - 执行单次 LLM 调用                                   │      │
│     │ - 处理流式响应事件                                     │      │
│     │ - 调用工具并格式化结果                                 │      │
│     │ - 返回本轮结果（continue/stop）                        │      │
│     └─────────────────────────────────────────────────────┘      │
│   }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 主要组件及职责

| 组件 | 职责 |
|------|------|
| **Lifecycle** | 外层循环控制器，管理整体执行流程、状态维护、并发控制 |
| **TurnProcessor** | 内层处理器，执行单次 LLM 交互、工具调用、事件处理 |
| **LoopEvent** | 事件类型定义，描述执行过程中的各类事件 |
| **LoopResult** | 结果类型定义，描述执行完成后的返回值 |

### 组件间依赖关系

```
Lifecycle
    ├── TurnProcessor（创建并调用）
    ├── Message（读取历史、写入消息和 Part）
    ├── Session（更新会话统计）
    ├── AgentManager（获取 Agent 配置）
    └── AbortSignal（检查取消信号）

TurnProcessor
    ├── LLMClient（执行 LLM 调用）
    └── ToolScheduler（执行工具调用）
```

---

## 二、Design Pattern and Rationale（设计模式与理由）

### 1. 双层循环模式

**使用理由**：
- 符合单一职责原则（SRP），外层负责"循环控制"，内层负责"单次交互"
- 便于独立测试各层逻辑
- 为未来扩展（压缩、子任务）预留扩展点

**不采用单层循环的理由**：
- 单层循环会将退出判断、LLM 调用、工具执行混在一起
- 代码可读性下降，难以维护

### 2. 依赖注入模式

**使用理由**：
- 便于测试时 mock 外部依赖
- 符合依赖倒置原则（DIP），依赖接口而非实现
- 调用方可灵活替换实现

**实现方式**：
```typescript
// 通过工厂函数或构造参数注入依赖
interface LifecycleDeps {
  llmClient: LLMClient
  toolScheduler?: ToolScheduler  // 可选，无工具时可不提供
  messageManager: MessageManager
  sessionManager: SessionManager
  agentManager: AgentManager
}
```

### 3. AsyncGenerator 模式

**使用理由**：
- 天然支持流式输出
- 调用方可按需消费事件
- 比回调函数更符合现代 JavaScript 风格
- 支持提前终止（通过 return）

**同时支持回调的理由**：
- 兼容简单使用场景
- 某些集成场景更适合回调

### 4. 未使用的模式

**未使用状态机（State Machine）**：
- 当前状态转换逻辑简单（running/stopped）
- 引入完整状态机会增加复杂度
- 未来如果状态增多，可考虑引入

**未使用观察者模式（Observer）**：
- AsyncGenerator 已满足事件通知需求
- 避免引入额外的事件分发机制

---

## 三、Module Structure and File Layout（模块结构与文件组织）

```
src/core/lifecycle/
├── index.ts              # 模块入口，导出公共 API
├── loop.ts               # Lifecycle 实现
├── processor.ts          # TurnProcessor 实现
├── types.ts              # 类型定义（事件、结果、配置）
├── errors.ts             # 自定义错误类型
└── __tests__/
    ├── loop.test.ts      # Lifecycle 单元测试
    ├── processor.test.ts # TurnProcessor 单元测试
    └── fixtures/         # 测试固定数据
```

### 各文件职责

| 文件 | 定位 | 说明 |
|------|------|------|
| `index.ts` | 公共接口 | 仅导出外部可用的类型和函数 |
| `loop.ts` | 核心逻辑 | Lifecycle 类，外层循环实现 |
| `processor.ts` | 核心逻辑 | TurnProcessor 类，内层处理实现 |
| `types.ts` | 类型定义 | 事件、结果、配置等类型 |
| `errors.ts` | 错误定义 | SessionBusyError 等自定义错误 |

### 对外稳定接口

以下内容构成模块的公共 API，修改需谨慎：
- `Lifecycle` 类及其 `run` 方法
- `LoopEvent` 类型
- `LoopResult` 类型
- `LifecycleDeps` 接口

### 内部实现

以下内容为内部实现，可自由重构：
- `TurnProcessor` 类（仅被 Lifecycle 内部使用）
- 工具结果格式化逻辑
- 并发控制的具体实现

---

## 四、Architectural Constraints and Trade-offs（约束与权衡）

### 约束 1: 内存状态 vs 持久化状态

**当前选择**：执行状态保存在内存中，执行过程中通过 Message 接口实时写入

**代价**：
- 进程崩溃时会丢失执行中的状态
- 无法实现"恢复执行"功能

**理由**：
- 当前阶段追求简单，YAGNI 原则
- 未来如需持久化，可在不改变接口的情况下升级

### 约束 2: 同步完成 vs 后台执行

**当前选择**：AsyncGenerator 完成即表示循环结束

**代价**：
- 调用方必须持有 generator 引用直到完成
- 不支持"发起后不管"的使用模式

**理由**：
- 更符合直觉的编程模型
- 后台执行可由上层封装实现

### 约束 3: 并发控制粒度

**当前选择**：在 Lifecycle 内部以 sessionId 为粒度控制

**代价**：
- 使用静态状态（Map），影响某些测试场景
- 不同 Lifecycle 实例共享状态

**理由**：
- 简化调用方使用
- 避免需要外部 SessionManager

### 约束 4: 工具执行时机

**当前选择**：在 TurnProcessor 内部同步执行工具

**代价**：
- 不支持工具并行执行
- 单个工具超时会阻塞整个循环

**理由**：
- 初始版本追求简单
- 并行执行可在 ToolScheduler 内部实现

## 五、中断机制设计

### 5.1 内部状态管理

Lifecycle 使用内部状态 Map 管理每个正在运行的 sessionId：

```typescript
interface LifecycleState {
  abortController: AbortController
  startTime: number
  step: number
  status: 'running' | 'aborting'
  // 重复调用时的等待者
  waiters: Array<{
    resolve: (result: LoopResult) => void
    reject: (error: Error) => void
  }>
}

// 模块私有状态
const lifecycleState = new Map<string, LifecycleState>()
```

**重要概念区分**：

| 概念 | 存储位置 | 生命周期 | 说明 |
|------|----------|----------|------|
| **Session（会话）** | 文件系统（持久化） | 长期存在 | 包含消息历史、元数据，由 Session 模块管理 |
| **LifecycleState（执行状态）** | 内存（lifecycleState Map） | 仅执行期间 | 记录"哪个会话正在执行循环"，循环结束即删除 |

- `lifecycleState` 不是存储会话数据，而是追踪"哪些会话正在执行循环"
- 中断或完成后从 `lifecycleState` 删除条目，**不影响 Session 本身**
- 用户可以随时继续对话，会创建新的执行状态条目

### 5.2 核心 API

```typescript
namespace Lifecycle {
  // 运行循环
  function run(params: RunParams): AsyncGenerator<LoopEvent, LoopResult, void>
  
  // 取消循环（触发中断信号）
  function cancel(sessionId: string): void
  
  // 检查是否正在运行
  function isRunning(sessionId: string): boolean
  
  // 等待已有循环完成（重复调用时使用）
  function waitForCompletion(sessionId: string): Promise<LoopResult>
}
```

### 5.3 中断触发方式

| 触发源 | 机制 | 说明 |
|--------|------|------|
| CLI (双击 Ctrl+C) | SIGINT → Lifecycle.cancel() | 500ms 内双击触发 |
| 子代理完成 | SubagentExecutor → 同时中断父子循环 | 级联中断 |

**Permission 等待时的特殊处理**：
- 当 Permission UI 等待用户决策时，Ctrl+C 不触发中断
- 用户应使用 Permission UI 的 "Reject" 按钮拒绝

### 5.4 中断处理流程

```
用户双击 Ctrl+C
    │
    ▼
CLI 层调用 Lifecycle.cancel(sessionId)
    │
    ▼
发布 Lifecycle.Event.AbortRequested
    │
    ▼
设置 state.status = 'aborting'
调用 state.abortController.abort()
    │
    ▼ (信号传递给各层)
╭───────────────────────────────────────╮
│ Lifecycle 循环                         │
│   ↓ signal                             │
│ TurnProcessor                          │
│   ↓ signal                             │
│ LLMClient / ToolScheduler              │
│   ↓ signal                             │
│ 具体工具执行                            │
╰───────────────────────────────────────╯
    │
    ▼
等待当前操作完成（软中断）
    │
    ▼
清理未完成的工具 Part（状态 → aborted）
    │
    ▼
创建 SystemMessage（kind: 'abort'）
    │
    ▼
发布 Lifecycle.Event.Aborted
    │
    ▼
从 lifecycleState 中删除执行状态条目
（注：会话本身保留，用户可继续对话）
    │
    ▼
通知所有 waiters
```

### 5.5 工具中断策略

| 工具类型 | 中断策略 | 说明 |
|----------|----------|------|
| readonly（read, glob, grep, list） | 软中断 | 等待当前操作完成 |
| write（write, edit） | 软中断 | 等待当前操作完成，避免文件损坏 |
| dangerous（bash） | **硬中断** | SIGTERM → 500ms → SIGKILL |
| network（web_search, web_fetch） | 软中断 | 等待请求完成或超时 |
| memory | 软中断 | 等待当前操作完成 |

**bash 工具硬中断实现**：
```typescript
const abortHandler = () => {
  Shell.killTree(proc, 'SIGTERM')
  setTimeout(() => {
    if (!proc.killed) Shell.killTree(proc, 'SIGKILL')
  }, 500)
}
signal.addEventListener('abort', abortHandler)
```

### 5.6 子代理中断处理

lifecycle 模块支持单击和双击 Ctrl+C 的差异化中断行为：

**单击 Ctrl+C（第一次）**：
- 只中断主代理当前的 LLM 调用
- **子代理继续运行**
- 显示提示："已中断当前操作。再次按 Ctrl+C 可终止所有子代理任务。"
- 记录 `lastCtrlCTime` 时间戳

**双击 Ctrl+C（500ms 内按两次）**：
- 中断主代理执行
- 调用 `SubagentExecutor.terminateAll(mainSessionId)`
- 所有子代理的 `SubtaskPart` 标记为：
  - `status: 'aborted'`
  - `terminationReason: 'aborted_by_user'`
- 显示提示："已终止所有任务"

```typescript
// 双击检测逻辑
const DOUBLE_CTRL_C_WINDOW = 500  // 毫秒

let lastCtrlCTime = 0

function handleCtrlC() {
  const now = Date.now()
  const isDoubleClick = (now - lastCtrlCTime) < DOUBLE_CTRL_C_WINDOW
  
  if (isDoubleClick) {
    // 双击：终止所有
    abortController.abort()
    SubagentExecutor.terminateAll(sessionId)
  } else {
    // 单击：只中断当前 LLM 调用
    abortController.abort()
    // 子代理继续运行
  }
  
  lastCtrlCTime = now
}
```

**主代理主动终止子代理**：

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

**子代理超时处理**：

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
```

### 5.7 中断后的消息处理

1. **未完成的 ToolPart**：状态更新为 `aborted`
   ```typescript
   { status: 'aborted', error: 'Tool execution aborted by user', ... }
   ```

2. **SystemMessage**：创建系统消息记录中断
   ```typescript
   { role: 'system', kind: 'abort', ... }
   ```

3. **对话上下文**：保留完整，允许用户继续对话

---

## 六、扩展预留点

虽然当前版本不实现，但架构预留了以下扩展点：

| 扩展功能 | 预留方式 |
|----------|----------|
| 上下文压缩 | 外层循环可插入压缩检查点 |
| 子任务并行 | TurnProcessor 可扩展为支持任务队列 |
| 执行恢复 | 可将状态序列化接口抽象出来 |
| 多 Agent 切换 | AgentManager 接口支持动态切换 |

---

## 七、文档自检

- [x] 每个组件存在的理由可以清楚说明
- [x] 所有结构可追溯到 goals-duty.md 中的职责
- [x] 没有为了"优雅"而增加的复杂度
- [x] 明确说明了被放弃的方案及其代价
- [x] 中断机制设计完整，包含状态管理、触发方式、处理流程
