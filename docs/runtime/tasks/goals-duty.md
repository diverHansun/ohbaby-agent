# tasks 模块 goals-duty.md

本文档定义 `runtime/tasks` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供独立于 agent loop 的后台工作单元抽象

Task 和 Run 是两个不同的概念：Run 是 agent loop 的一次执行，Task 是 agent 在 loop 之外发起的需要长时间运行的后台工作（如：在后台执行 bash 脚本、持续监听文件变化、运行 build pipeline）。tasks 模块为这类工作提供独立的生命周期管理，使其不阻塞 agent loop 也不被 Run 的取消所影响（除非明确关联）。

### 2. 支持可查询、可停止的后台任务台账

task 创建后，agent 可以在后续 turn 中查询其状态和输出，也可以主动停止。没有台账的后台任务一旦启动就变成"黑盒"，无法在 agent 的推理中有效利用。

### 3. 区分任务隔离级别，以可配置的方式选择执行环境

某些任务需要强隔离（运行 shell 命令、执行用户脚本、可能污染环境变量），应在 subprocess 中运行。某些任务只是轻量异步工作（监听事件、定期检查），在同进程 async 中运行即可。tasks 模块支持通过任务类型配置 `isolation` 级别，不强制所有任务走 subprocess。

### 4. 让后台任务继承 Session 的执行上下文

后台 shell task 虽然独立于 agent loop，但它通常仍然属于某个 session 的工作环境。tasks 模块需要从 sandbox 获取该 session 的 `workdir` 和命令绑定信息，确保后台 build、watch、test 等任务运行在和当前 agent 一致的目录边界里，而不是各自猜测 cwd 或绕过容器/远程后端。

---

## 二、Duties（职责）

### 1. 管理 TaskRecord 的生命周期

负责：
- 创建 TaskRecord（分配 taskId，记录类型、isolation、状态、关联的 sessionId 和可选的 runId）
- 维护 TaskRecord 的状态转换（pending → running → succeeded / failed / cancelled / timeout）
- 提供 `get(taskId)` / `list(sessionId?)` / `waitForCompletion(taskId, timeout?)` 接口

### 2. ShellTask 的启动与管理

负责：
- 将 shell 命令作为 subprocess 启动（Node.js `child_process.spawn`）
- 在启动前通过 sandbox 解析 `sessionId` 对应的 command context，作为 subprocess 的 `command` / `args` / `cwd` / `env`
- 将 stdout / stderr 写入任务输出文件（滚动写入，不全部缓冲内存）
- 提供 `readOutput(taskId, fromLine?)` 接口供 agent 在 turn 中读取输出片段
- 支持 `stop(taskId)` 发送 SIGTERM 到 subprocess

### 3. 同进程异步任务的管理

负责：
- 将轻量异步工作（如事件监听、周期检查）作为 async task 启动
- 通过 AbortSignal 支持取消
- 捕获未处理的 Promise rejection 并更新 TaskRecord 状态

### 4. 任务输出的可查询性

负责：
- 为每个 subprocess task 分配独立的输出文件（避免跨 task 污染）
- 提供基于行号的分页读取接口（agent 可逐步拉取输出，不一次性加载全部）
- 支持实时订阅（task 运行中时，agent 可 await 新输出行）

### 5. 任务超时

负责：
- 在创建 task 时支持 `timeoutMs` 参数
- 超时后自动发送 SIGTERM，等待 graceful exit，超时后发送 SIGKILL
- 更新 TaskRecord 状态为 `timeout`

---

## 三、Non-Duties（非职责）

### 1. 不负责 agent loop 的执行

task 不是 Run。如果需要在后台运行 agent loop，应创建一个 `trigger: 'follow-up'` 或类似触发源的 Run，而不是通过 tasks 模块。tasks 模块不调用 `core/lifecycle`。

### 2. 不负责 Subagent 的管理

Subagent 是嵌套 Run（有 parentRunId），由 `runtime/run-manager` 管理。tasks 模块管理的是 agent 发起的外部工作，不是另一个 agent。

### 3. 不负责工具调用的执行

工具调用（BashTool、FileTool 等）在 `core/tool-scheduler` 中同步或异步执行，属于 agent loop 的一部分。tasks 是 agent loop 启动的"附属后台工作"，不是工具调用的替代品。

### 4. 不负责任务的调度与触发

tasks 模块不知道"什么时候应该启动哪个 task"。触发时机由 agent loop（在某个 turn 中决定创建 task）或 `runtime/scheduler`（定期任务）决定。

### 5. 不负责 cost / token 的追踪

task 如果是 shell 命令，没有 token 成本。cost 追踪针对 LLM 调用，由 `runtime/run-manager` 或 `core/lifecycle` 层处理。

### 6. 不负责任务输出的语义解析

tasks 模块只负责将 subprocess 输出写入文件并提供行级读取接口。输出内容的语义解析（如提取 test result、parse build error）由 agent 在 turn 中自行完成。

### 7. 不负责创建、切换或绕过 Sandbox

tasks 模块只消费 sandbox 提供的执行上下文和命令绑定，不决定当前 session 使用原始目录、worktree 还是容器，也不直接创建这些环境。即使当前实现是本地 subprocess，tasks 也不应自己拼接容器命令或远程命令。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `core/tool-scheduler` | 被调用 | agent tool（如 BashBackgroundTool）调用 tasks 模块创建 task |
| `runtime/run-manager` | 无直接依赖 | task 和 run 是平行概念，run-manager 不管理 task |
| `sandbox` | 依赖 | ShellTask 启动前通过 sandbox 获取当前 session 的工作目录和命令绑定 |
| `runtime/daemon` | 被持有 | daemon 创建 TaskManager 实例，退出时停止所有 running task |
| `bus` | 发布 | TaskRecord 状态变更时发布 Bus 事件（可选，供 UI 观测） |
| `services/session` | 可选依赖 | 任务元信息可持久化到 session storage（未来阶段） |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：agent 通过 tool 创建后台 shell task
```typescript
// agent 在 turn 中调用 BashBackgroundTool，tool 调用 tasks 模块
const context = await sandboxManager.getContext(sessionId)
const commandContext = await sandboxManager.resolveCommandContext(context, {
  command: 'npm',
  args: ['run', 'build'],
})

const task = await taskManager.createShellTask({
  sessionId,
  command: commandContext.command,
  args: commandContext.args,
  isolation: 'subprocess',
  timeoutMs: 300_000,
  cwd: commandContext.cwd,
  env: commandContext.env,
})
// tool 返回 taskId 给 LLM
```

正确：agent 在后续 turn 读取任务输出
```typescript
// agent 通过 ReadTaskOutputTool 读取
const output = await taskManager.readOutput(taskId, { fromLine: 0, maxLines: 50 })
```

### 5.2 职责外的示例

错误：tasks 不应运行 agent loop
```typescript
// 错误：不应该在 tasks 模块中
const task = taskManager.createAgentTask({
  prompt: 'analyze this file',
  // 内部调用 lifecycle.run()  ← 错误
})

// 正确：后台 agent loop 应通过 run-manager 创建 follow-up Run
```

错误：tasks 不应自行推断或创建工作目录
```typescript
// 错误：不应该在 tasks 模块中
const cwd = path.join(projectRoot, '.worktrees', sessionId)

// 正确：cwd / argv / env 应由 sandbox command context 提供
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：tasks 模块管理 agent 在 loop 之外发起的后台工作单元（shell subprocess / 异步任务），并让这些任务继承当前 session 的执行上下文
- 能清楚回答"这个模块不该做什么"：不运行 agent loop、不管理 subagent、不替代工具调用、不负责调度触发、不做 cost 追踪、不做输出语义解析、不创建 sandbox
- 职责与其他模块无明显重叠：run-manager（Run 管理）、sandbox（执行环境）、core/tool-scheduler（工具调用）、scheduler（时间触发）边界清晰
