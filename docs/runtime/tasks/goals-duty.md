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

### 4. 以三级文件访问策略区分 workspace-bound task 与 system task

不同类型的 task 对文件系统的访问需求完全不同。tasks 模块将文件访问策略提升为显式的任务属性，而不是让每个 task 自行推断 cwd：

```typescript
type TaskFileAccess =
  | 'none'          // 只用 services/database 或 services/storage，不碰项目文件
  | 'workspace-ro'  // 读取 session sandbox workdir（需持有 SandboxLease）
  | 'workspace-rw'  // 读写 session sandbox workdir（需持有 SandboxLease + 显式授权）
```

`none` 是 system/async task 的默认值。`createShellTask()` 这类 workspace-capable task 必须显式声明 `fileAccess`，避免在没有边界声明的情况下默认进入项目目录。`workspace-rw` 不能是默认值，必须在创建 task 时显式声明，且只应由内置可信 task 发起或经过 policy/permission 授权。

| Task 类型 | 文件访问策略 | 底层依赖 |
|---|---|---|
| 清理 task 输出日志 / artifact | `none` | `services/storage` |
| DB vacuum / scheduler cleanup | `none` | `services/database` |
| embedding 索引（读源码，写向量） | `workspace-ro` 读 + 输出写 DB/storage | sandbox + database/storage |
| build / watch / test shell task | `workspace-ro` 或 `workspace-rw` | sandbox |
| 自动格式化、生成文件类后台任务 | `workspace-rw`（显式声明） | sandbox + 授权 |

### 5. workspace-bound task 必须持有 SandboxLease

task 对项目工作区的所有文件操作都必须通过 SandboxManager 获取该 session 的 `SandboxContext` / `SandboxLease`，不自行拼接路径、不使用进程 cwd、不知道 worktree/container/remote 细节。持有 lease 确保：session reset 或 sandbox cleanup 不会在 task 还在运行时提前删除执行环境。task 结束、取消或 timeout 时必须 release lease。

---

## 二、Duties（职责）

### 1. 管理 TaskRecord 的生命周期

负责：
- 创建 TaskRecord（分配 taskId，记录类型、isolation、`fileAccess` 策略、状态、关联的 sessionId 和可选的 runId）
- 维护 TaskRecord 的状态转换（pending → running → succeeded / failed / cancelled / timeout）
- 提供 `get(taskId)` / `list(sessionId?)` / `waitForCompletion(taskId, timeout?)` 接口

### 2. WorkspaceTask（workspace-ro / workspace-rw）的 SandboxLease 管理

负责：
- 在 task 启动前调用 `sandboxManager.acquire(sessionId)` 获取 `SandboxLease`，失败则阻止 task 进入 running 状态
- 将 lease 中的 `workdir` / `commandContext` 传入 task 执行环境（subprocess 的 `cwd` / `env` / `command` / `args`）
- task 结束（succeeded / failed）、取消（cancelled）或超时（timeout）时必须调用 `lease.release()`
- 不自行拼接路径（不用 `projectRoot/.worktrees/sessionId`）、不使用进程 cwd、不知道 worktree/container/remote 实现细节

### 3. ShellTask 的启动与管理

负责：
- 将 shell 命令作为 subprocess 启动（Node.js `child_process.spawn`）
- 在启动前通过 `SandboxLease` 获取 command context（command / args / cwd / env）
- 将 stdout / stderr 写入 `services/storage` 管理的任务输出文件（滚动写入，不全部缓冲内存）
- 提供 `readOutput(taskId, fromLine?)` 接口供 agent 在 turn 中读取输出片段
- 支持 `stop(taskId)` 发送 SIGTERM 到 subprocess

### 4. 同进程异步任务的管理

负责：
- 将轻量异步工作（如事件监听、周期检查）作为 async task 启动
- 通过 AbortSignal 支持取消
- 捕获未处理的 Promise rejection 并更新 TaskRecord 状态

### 5. 任务输出的可查询性

负责：
- 为每个 subprocess task 分配独立的输出文件（避免跨 task 污染）
- 提供基于行号的分页读取接口（agent 可逐步拉取输出，不一次性加载全部）
- 支持实时订阅（task 运行中时，agent 可 await 新输出行）

### 6. 任务超时

负责：
- 在创建 task 时支持 `timeoutMs` 参数
- 超时后自动发送 SIGTERM，等待 graceful exit，超时后发送 SIGKILL
- 更新 TaskRecord 状态为 `timeout`

---

## 三、Non-Duties（非职责）

### 1. 不负责 agent loop 的执行

task 不是 Run。如果需要在后台运行 agent loop，应创建一个 `triggerSource: 'follow-up'` 或类似触发源的 Run，而不是通过 tasks 模块。tasks 模块不调用 `core/lifecycle`。

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

### 7. 不负责创建、切换或绕过 Sandbox，不自行推断 workdir

tasks 模块只消费 sandbox 提供的 SandboxLease，不决定当前 session 使用原始目录、worktree 还是容器，也不直接创建这些环境。即使当前实现是本地 subprocess，tasks 也不能自行拼接路径（`projectRoot/.worktrees/sessionId`）或绕过 sandbox 的路径校验和租约生命周期管理。`workspace-rw` task 必须在 SandboxLease 提供的边界内操作，不能通过绝对路径绕出 workdir。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `core/tool-scheduler` | 被调用 | agent tool（如 BashBackgroundTool）调用 tasks 模块创建 task |
| `runtime/run-manager` | 无直接依赖 | task 和 run 是平行概念，run-manager 不管理 task |
| `sandbox` | 依赖（workspace task） | `fileAccess != 'none'` 的 task 启动前通过 sandbox 获取 SandboxLease |
| `services/storage` | 依赖 | system task 的数据读写（日志、artifact、embedding 输出）；ShellTask 的 stdout/stderr 输出文件 |
| `services/database` | 依赖 | system task 的结构化数据读写（DB vacuum、scheduler cleanup、embedding 向量索引） |
| `runtime/daemon` | 被持有 | daemon 创建 TaskManager 实例，退出时停止所有 running task 并 release 所有 lease |
| `bus` | 发布 | TaskRecord 状态变更时发布 Bus 事件（可选，供 UI 观测） |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：workspace-rw shell task，通过 SandboxLease 获取执行上下文
```typescript
// fileAccess: 'workspace-rw' 必须在创建时显式声明
const task = await taskManager.createShellTask({
  sessionId,
  command: 'npm',
  args: ['run', 'build'],
  isolation: 'subprocess',
  fileAccess: 'workspace-rw',  // 显式声明，不能省略
  timeoutMs: 300_000,
  // cwd / env 由 TaskManager 在 SandboxLease.acquire() 后自动填入
})
// tool 返回 taskId 给 LLM
```

正确：system task（DB cleanup），不需要 sandbox
```typescript
// fileAccess: 'none'（system/async task 默认值），只用 database，不碰 workdir
const task = await taskManager.createAsyncTask({
  kind: 'db-vacuum',
  fileAccess: 'none',
  fn: async (signal) => {
    await db.run('VACUUM')
  },
})
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

错误：tasks 不应自行推断工作目录，也不应绕过 sandbox
```typescript
// 错误：不应该在 tasks 模块中
const cwd = path.join(projectRoot, '.worktrees', sessionId)

// 错误：默认 workspace-rw，或不声明 fileAccess
const task = await taskManager.createShellTask({ sessionId, command: 'rm -rf tmp' })

// 正确：cwd 由 SandboxLease 提供，fileAccess 显式声明
const task = await taskManager.createShellTask({
  sessionId,
  command: 'rm -rf tmp',
  fileAccess: 'workspace-rw',  // 必须显式声明写权限
  // cwd 由 TaskManager 从 lease.workdir 自动填入
})
```

错误：embedding task 不应把向量文件直接写入项目目录
```typescript
// 错误：不应该在 embedding task 中
fs.writeFileSync(path.join(workdir, '.embeddings/index.bin'), vectorData)

// 正确：embedding 输出写入 services/storage
await storage.writeBytes(['embeddings', sessionId, 'index'], vectorData)
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：tasks 模块管理 agent 在 loop 之外发起的后台工作单元，以三级 `TaskFileAccess` 策略区分 workspace-bound task（持 SandboxLease）与 system task（只用 storage/database），不绕过 sandbox
- 能清楚回答"这个模块不该做什么"：不运行 agent loop、不管理 subagent、不替代工具调用、不负责调度触发、不做 cost 追踪、不做输出语义解析、不创建 sandbox、不自行推断 workdir、不让 workspace-rw 成为默认值
- 职责与其他模块无明显重叠：run-manager（Run 管理）、sandbox（执行环境实现）、core/tool-scheduler（工具调用）、scheduler（时间触发）、services/storage（system task 数据）边界清晰
- `TaskFileAccess` 的三层分类（none / workspace-ro / workspace-rw）是文件访问权限的单一权威来源，不允许 task 在策略声明之外直接操作文件系统
