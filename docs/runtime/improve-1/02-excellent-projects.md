# 优秀项目借鉴分析

> 历史快照：本文保留早期横向分析口径。当前 runtime MVP 结论以 `03-implementation-plan.md` 和 `packages/ohbaby-agent/src/permission/improve-1/01-permission-policy-boundary.md` 为准：scheduler / heartbeat 后置，permission profile 语义不放在 runtime。

> 对 kimi-code、OpenCode、Claude Code 的 runtime 架构进行横向对比，提炼可借鉴的设计模式。

---

## 1. 项目概况

| 项目 | 语言 | 范式 | Runtime 规模 | 核心特点 |
|---|---|---|---|---|
| **kimi-code** | TypeScript | 纯函数 + 类组合 | ~5000 行（loop/ + agent/ + turn/） | 三层分离（loop → TurnFlow → Agent），资源感知并发 |
| **OpenCode** | TypeScript | Effect-TS 函数式 | ~3500 行（session/ + bus/） | 代数效应系统，PubSub 事件总线 |
| **Claude Code** | TypeScript | 类 + 异步生成器 | ~6000 行（query.ts + QueryEngine） | 无限循环 + 可变 State，丰富的 compact 策略 |

---

## 2. 与 ohbaby 待实现模块最相关的设计

### 2.1 心跳/调度机制 — 最相关：kimi-code 的 Agent 状态机

#### ohbaby 规划：

```
heartbeat/
  HeartbeatMachine: agentState ∈ {active, paused, blocked, sleeping}
  DeferredQueue: 暂停时缓存信号，恢复后按优先级 drain
  Disposition 协议: heartbeat 决定是否创建 run

scheduler/
  MinHeap + setTimeout 事件驱动
  Job 类型: ScheduledJob / Reminder / FollowUp
  Reminder at-least-once: 需 heartbeat 确认 disposition 后才完成
```

#### 借鉴来源：kimi-code

kimi-code 没有独立的 heartbeat/scheduler 模块，但其 `Agent` 类的状态管理模式值得学习：

**a) Agent 状态通过配置而非状态机管理**

```typescript
// kimi-code: packages/agent-core/src/agent/index.ts
class Agent {
  private permissions: PermissionManager;  // 控制工具是否可以执行
  private planMode: PlanMode;              // 控制是否为计划模式
  private configState: ConfigState;        // 控制模型/thinking level
}
```

kimi-code 不使用显式的 `agentState` 枚举，而是把"agent 能否响应"分散到多个正交的子系统：
- **权限系统**：yolo 模式 = "不询问直接执行" ≈ ohbaby 的 `full-auto` profile
- **PlanMode**：计划模式下 agent 不直接操作，只输出计划
- **ConfigState**：控制模型选择、thinking 级别

**对 ohbaby 的启示**：heartbeat 规划的 `AgentState` 状态机可以简化。不需要 4 种状态，核心只需要判断：
1. 有 run 在跑？→ blocked（排队 / 中断 / 拒绝）
2. 权限 profile 允许？→ 检查 `canAskUser` 等相关字段
3. 用户标记为暂停？→ paused

**b) 取消与中断链**

```typescript
// kimi-code: 每一步都检查 AbortSignal
async function runTurn(signal: AbortSignal) {
  signal.throwIfAborted();           // 循环入口
  while (true) {
    signal.throwIfAborted();         // 每步检查
    const result = await chat(signal); // 传入 LLM 调用
    signal.throwIfAborted();         // 结果后检查
  }
}
```

kimi-code 把 `AbortSignal` 穿过每一层（loop → LLM → tool execution），工具即使忽略 signal 也会被 2 秒 grace timeout 强制中断。

**对 ohbaby 的启示**：heartbeat 不需要自己管理 run 的取消——run-manager 的 `AbortController` 已经存在。heartbeat 需要的是：决定"是否创建 run"（Disposition），而不是管理 run 的执行。

**c) 资源感知的并发控制**

kimi-code 的 `ToolScheduler` 根据文件读写声明决定并行/串行：
```typescript
interface ToolAccess {
  reads?: string[];    // 读路径
  writes?: string[];   // 写路径
  all?: boolean;       // 全局互斥
}
```

ohbaby 已在 `core/tool-scheduler/concurrency.ts` 中实现了类似机制（read/write locking），但可以作为 heartbeat 的参考——heartbeat 在决定"是否创建 run"时，应检查当前 run 的工具是否持有文件锁。

---

### 2.2 钩子系统 — 最相关：kimi-code 的 LoopHooks + Claude Code 的 stop hooks

#### ohbaby 规划：

```
hooks/
  HookExecutor（责任链模式）
  钩子点: pre-run, post-run, on-wake
  钩子是纯 async 函数，无优先级，不阻塞主流程
```

#### 借鉴来源 A：kimi-code 的 LoopHooks

kimi-code 的钩子设计是 **控制流钩子 + 观察钩子** 的双层架构：

```typescript
// kimi-code: packages/agent-core/src/loop/types.ts
interface LoopHooks {
  beforeStep?(ctx): Promise<StepDecision>;     // 可以阻止步骤执行
  afterStep?(ctx): Promise<void>;              // 纯观察
  shouldContinueAfterStop?(ctx): Promise<boolean>; // 可以强制继续
  prepareToolExecution?(ctx): Promise<ToolExecDecision>;
  finalizeToolResult?(ctx): Promise<ToolResultDecision>;
}

interface LoopEventEmitter {
  onEvent?(event: LoopEvent): void;            // 纯观察，不阻塞
}
```

关键区别：
- **Hooks 可返回决策**：`beforeStep` 返回 `StepDecision`（continue/stop/skip），`prepareToolExecution` 可修改工具参数或阻止执行
- **Emitter 纯观察**：`onEvent` 不能影响执行流
- **双通道分离**：控制流和观察流是独立接口

#### 借鉴来源 B：Claude Code 的 Stop Hooks

```typescript
// claude-code: src/query/stop-hooks.ts（简化）
interface StopHook {
  shouldStop?(turnContext): Promise<{ stop: boolean; reason?: string }>;
  onStop?(turnContext): Promise<void>;
}
```

Claude Code 在每次 LLM 调用完成后，按优先级执行 stop hooks。任何一个 hook 返回 `stop: true` 就会终止循环。这比 ohbaby 的单一 `shouldStopAfterTurn` 更灵活（允许多个 hook 各自表达停止条件）。

#### 对 ohbaby 的建议设计

结合 kimi-code 和 Claude Code，ohbaby 的 hooks 应该演进为：

```typescript
// 建议的 hooks 接口（替代当前单一 HookExecutor）
interface HookRegistry {
  // 控制流钩子（可返回决策）
  on(point: "pre-run", hook: PreRunHook): Dispose;
  on(point: "post-run", hook: PostRunHook): Dispose;
  on(point: "on-wake", hook: OnWakeHook): Dispose;
  on(point: "pre-message", hook: PreMessageHook): Dispose;
  on(point: "post-message", hook: PostMessageHook): Dispose;

  // 观察钩子（不返回决策）
  watch(point: "tool:start", observer: ToolObserver): Dispose;
  watch(point: "tool:result", observer: ToolObserver): Dispose;
}

interface PreRunHook {
  (ctx: RunHookContext): Promise<{ proceed: boolean; reason?: string }>;
}
// proceed=false → 阻止 run 创建
```

---

### 2.3 任务系统 — 最相关：Claude Code 的 Background Tasks

#### ohbaby 规划：

```
tasks/
  TaskManager + ShellTaskRunner/AsyncTaskRunner + OutputStore
  三级 fileAccess: none / workspace-ro / workspace-rw
```

#### 借鉴来源：Claude Code 的 Background Tasks

Claude Code 有一个成熟的 background task 系统：

```typescript
// claude-code: src/Task.ts（简化）
type TaskState = "pending" | "running" | "completed" | "failed" | "killed";

interface Task {
  id: string;
  type: "local_bash" | "local_agent" | "remote_agent" | "local_workflow" | "dream";
  state: TaskState;
  output: string;  // 文件路径，包含 stdout/stderr
}
```

关键设计：
- **输出写入磁盘**：stdout/stderr 写入文件而非内存，支持大输出
- **Ctrl+B 两次切后台**：前台任务可转为后台，后台任务可切回前台
- **Symlink 到 transcript**：任务输出通过符号链接关联到对话记录

对 ohbaby 的启示：
1. ohbaby 规划的 `OutputStore` 应该使用文件系统（类似 Claude Code），而非全内存
2. `ShellTaskRunner` 需要处理 Windows 和 POSIX 的进程管理差异（参考 kimi-code 的 KAOS/process.ts 中的 `taskkill /T` vs `kill(-pid)`）
3. 不需要 Claude Code 那么多种 task 类型，ohbaby 只需要 `shell` 和 `async` 两种

---

### 2.4 权限系统 — 最相关：kimi-code 的 PermissionManager

#### ohbaby 规划：

```
permission-profiles/
  ProfileRegistry + applyProfile() 纯函数
  4 种 profile: interactive / read-only / notify-only / full-auto
```

#### 借鉴来源：kimi-code 的 PermissionManager

```typescript
// kimi-code: packages/agent-core/src/agent/permission.ts（简化）
type PermissionMode = "yolo" | "auto" | "ask";

class PermissionManager {
  mode: PermissionMode;
  canUseTool(toolName, params): Promise<{ allowed: boolean; reason?: string }>;
  onDenied(toolName, params): Promise<DeniedAction>;
}
```

关键设计：
- **权限模式是动态可切换的**：用户可以 `/permission yolo` 切换
- **工具级别检查**：每个工具的 `canUse` 检查可以独立
- **DeniedAction 有回退**：工具被拒绝后，有 skip/ask/abort 三种策略

对 ohbaby 的启示：
1. ohbaby 规划的 4 种 profile 实际上就是 kimi-code 的 3 种 mode + notify-only（read-only + 通知）
2. `applyProfile()` 应该是一个纯函数，输入 profile + tool 元数据，输出 `{ allowed, onDenied }`
3. Profile 不应该只在 run 创建时生效，而应该在每次工具调用时检查（因为用户可能中途切换权限）

ohbaby 的实现路径：
```typescript
function applyProfile(
  profile: PermissionProfile,
  tool: { name: string; isReadOnly: boolean; isDangerous: boolean }
): { allowed: boolean; onDenied: "prompt" | "skip" | "abort" } {
  switch (profile.id) {
    case "full-auto":    return { allowed: true, onDenied: "skip" };
    case "interactive":  return { allowed: true, onDenied: "prompt" };
    case "read-only":    return { allowed: tool.isReadOnly, onDenied: "skip" };
    case "notify-only":  return { allowed: tool.isReadOnly, onDenied: "prompt" };
  }
}
```

---

### 2.5 流事件架构 — 最相关：kimi-code 的双通道事件

#### 借鉴来源：kimi-code 的 Recorded vs Live-only 事件

```typescript
// kimi-code 的事件分类
// Recorded（持久化 + 实时推送）:
content.part       // 完成的文本/思考块 → 写入 JSONL transcript
tool.call          // 工具调用 → 写入 transcript
tool.result        // 工具结果 → 写入 transcript
step.begin/end     // 步骤边界 → 写入 transcript

// Live-only（仅实时推送，不持久化）:
text.delta         // 流式文本增量 → UI only
thinking.delta     // 流式思维增量 → UI only
tool.call.delta    // 流式参数增量 → UI only
tool.progress      // 工具进度 → UI only
```

对 ohbaby 的启示：

ohbaby 当前所有事件都走 StreamBridge，没有持久化语义。未来如果要支持 session 重放，需要区分：
- **哪些事件需要持久化**（写入 RunLedger 或事件存储）
- **哪些事件只是给 UI 的实时流**

这不在本次实施范围内（P3 或后续版本），但设计 heartbeat/hooks 时应预留接口。

---

### 2.6 LLM 重试 — 最相关：kimi-code 的 chatWithRetry

#### 借鉴来源：kimi-code 的指数退避重试

```typescript
// kimi-code: packages/agent-core/src/loop/retry.ts（简化）
import retry from 'retry';

function chatWithRetry(
  chat: () => Promise<Result>,
  signal: AbortSignal,
  options: RetryOptions
): Promise<Result> {
  const op = retry.operation({
    retries: options.maxRetries ?? 2,
    factor: options.factor ?? 2,
    minTimeout: options.minTimeout ?? 1000,
    maxTimeout: options.maxTimeout ?? 10000,
  });

  return new Promise((resolve, reject) => {
    op.attempt(async () => {
      signal.throwIfAborted();
      try {
        const result = await chat();
        if (isRetryableError(result)) {
          throw result;
        }
        resolve(result);
      } catch (err) {
        if (isRetryableHTTPStatus(err) || isConnectionError(err)) {
          if (!op.retry(err)) reject(op.mainError());
        } else {
          reject(err);
        }
      }
    });
  });
}

function isRetryableHTTPStatus(err): boolean {
  return err.status === 429 || err.status >= 500;  // 429 + 5xx
}
```

对 ohbaby 的启示：
- 重试范围：429（限流）、5xx（服务端错误）、连接超时/中断
- 不重试：4xx（参数错误）、空响应（模型无输出）
- 重试时检查 `AbortSignal`——用户取消时立即停止
- ohbaby 已有的 `runWithBusyRetry`（SQLite 重试）可以复用其指数退避模式

---

### 2.7 进程管理 — 最相关：kimi-code 的 KAOS

#### 借鉴来源：kimi-code 的跨平台进程管理

```typescript
// kimi-code: packages/kaos/src/kaos.ts
interface Kaos {
  exec(command: string, ...args: string[]): Promise<KaosProcess>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  // ...
}

// kimi-code: packages/kaos/src/local.ts
class LocalKaos implements Kaos {
  kill(pid: number, signal: string) {
    if (process.platform === 'win32') {
      // Windows: taskkill /T /PID {pid}
      execSync(`taskkill /T /F /PID ${pid}`);
    } else {
      // POSIX: kill(-pid, signal) — kill process group
      process.kill(-pid, signal);
    }
  }
}
```

对 ohbaby 的启示：
- `tasks/` 的 `ShellTaskRunner` 需要处理 Windows → `taskkill /T`，POSIX → `kill(-pid)`
- kimi-code 的 `Kaos` 接口值得借鉴：文件系统 + 进程执行统一抽象
- 如果 ohbaby 未来要支持远程执行（SSH），这个抽象层会很有价值

---

## 3. 不要借鉴的反模式

### 3.1 Claude Code 的 monolithic main.tsx（4000+ 行）

Claude Code 的入口文件把所有初始化逻辑塞在一个文件。ohbaby 已有较好的模块拆分（daemon/bootstrap + supervisor），应继续保持。

### 3.2 Claude Code 的 mutable State 对象

```typescript
// claude-code: src/query.ts
while (true) {
  state.messages = [...state.messages, ...newMessages];  // 变异
  state.step++;
  await doSomething(state);
}
```

ohbaby 的 `Lifecycle` 使用参数传递和返回值，应保持这种纯函数风格。

### 3.3 OpenCode 的 Effect-TS 的学习曲线

OpenCode 的 Effect-TS 虽然强大，但学习曲线陡峭。ohbaby 的 TypeScript 原生 async/await + 类组合模式已经足够清晰。

---

## 4. 对 ohbaby 实施的影响总结

| 模块 | 最重要的借鉴来源 | 关键设计决策 |
|---|---|---|
| **heartbeat** | kimi-code 的状态分散管理 | 简化 4 状态机 → 核心只判断"能否创建 run" |
| **hooks** | kimi-code 的控制流钩子 + Claude Code 的 stop hooks | 区分控制流钩子（返回决策）和观察钩子（纯观察） |
| **tasks** | Claude Code 的文件输出 + kimi-code 的跨平台进程 | 输出写文件、Windows 用 taskkill |
| **scheduler** | ohbaby 自身规划文档 | 规划已经很详细，按文档实现 |
| **permission-profiles** | kimi-code 的 PermissionManager | 每次工具调用时检查（不是只在 run 创建时） |
| **LLM retry** | kimi-code 的 chatWithRetry | 指数退避、429+5xx 重试、检查 AbortSignal |
