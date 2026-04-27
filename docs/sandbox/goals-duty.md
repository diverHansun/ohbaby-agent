# sandbox 模块 goals-duty.md

本文档定义 `sandbox` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 将执行环境提升为 Session 级基础设施

ohbaby-agent 的 Tool call、Turn、Run 都是短生命周期概念，但文件系统工作目录和隔离边界通常要跨多个 Run 复用。sandbox 模块的存在，是为了把"代码在哪里执行"从单次工具调用里抽出来，提升为一个可复用、可查询、可清理的 Session 级基础设施。

### 2. 用统一契约屏蔽不同的执行后端

个人助手场景可能直接在原始目录运行，Coding CLI 场景可能使用 git worktree，未来也可能进入 Docker 容器或远程环境。sandbox 应通过统一的 `SandboxContext` / `SandboxAdapter` 契约屏蔽这些差异，让上层只依赖稳定接口，而不是直接感知 worktree、container、ssh 等实现细节。

### 3. 为工具执行与后台任务提供一致的工作目录视图

同一个 session 中，tool-scheduler 执行工具、tasks 启动后台 shell 任务、snapshot 记录变更时，都应看到一致的 `workdir` 和项目边界。sandbox 的目标不是调度命令，也不解释命令结果，而是为这些调用方提供同一份执行上下文和后端绑定方式，避免每个模块各自推导 cwd 或手写 Docker/SSH/worktree 细节。

### 4. 保持与审批、运行台账、快照账本的明确解耦

sandbox 只回答"在哪里执行"和"隔离边界是什么"，不回答"是否允许执行"，也不回答"本轮改了什么、如何回滚"。审批属于 `core/policy` + `core/permission`，运行台账属于 `runtime/run-manager`，变更账本属于 `snapshot`。

---

## 二、Duties（职责）

### 1. 定义 SandboxContext 与 SandboxAdapter 契约

负责：
- 定义 `SandboxContext`：至少包含 `sessionId`、`adapterId`、`projectRoot`、`workdir`、`isolated`、`capabilities`
- 定义 `SandboxAdapter` 生命周期接口：`init()` / `acquire()` / `getContext()` / `release()` / `cleanup()`
- 明确 `SandboxLease` 或等价租约语义：同一 session 可被多个 Run / Task 并发引用，调用方必须释放租约，adapter 根据引用计数或 lease token 决定何时可清理
- 允许 adapter 在内部维护额外句柄（如 worktree 信息、container id、ssh connection），但不把这些句柄暴露为产品级公共概念

### 2. 为每个 Session 创建、复用和释放执行环境

负责：
- 在 session 首次进入可执行状态时，为其建立 sandbox context
- 同一 session 的后续 Run 复用同一个 context，而不是每次 tool call 重新创建环境
- 在 session 结束、显式 reset、或项目切换时释放并清理该 context

### 3. 向上层模块提供统一的执行上下文查询接口

负责：
- 提供 `getContext(sessionId)` 或等价接口，供 run-manager、tasks、执行层查询当前 `workdir`
- 保证调用方无需知道底层是原始目录、git worktree 还是容器挂载目录
- 让 shell task、文件工具、快照模块都基于同一份 `SandboxContext` 工作

### 4. 管理执行环境的生命周期清理

负责：
- 对 worktree / container / remote session 等隔离后端执行创建与销毁
- 对原始目录模式执行 no-op 清理，但仍维护统一的生命周期接口
- 在异常退出恢复时，支持识别并清理残留的隔离资源

### 5. 屏蔽底层环境句柄与后端实现差异

负责：
- 将 Docker exec 句柄、SSH 连接、worktree 元数据等能力保留在 adapter 内部
- 对外只暴露稳定的上下文信息与必要的操作接口
- 避免把 process、thread、container handle 这些实现细节提升为独立产品模块

### 6. 强制执行工作区边界与能力声明

负责：
- 对所有路径输入做 resolve / normalize，并验证其位于 `projectRoot`、`workdir` 或显式 allow list 内；路径逃逸时必须拒绝，而不是交给工具自行处理
- 暴露只读、可写、网络访问、是否强隔离、是否 host-local 等能力元数据，供 policy / permission / tools 做更细粒度判断
- 当用户或 profile 要求强隔离，但当前平台或后端不可用时，必须 fail-closed；仅在显式 unsafe / host-local 模式下允许降级
- 在 Windows、WSL、Docker、remote 等后端能力不一致时，返回可解释的 unavailable reason，避免静默退回到宿主机执行

### 7. 提供命令执行绑定，而不接管调度

负责：
- 提供 `resolveCommandContext()` / `wrapCommand()` 或等价能力，让 `runtime/tasks` 和工具执行层知道命令应如何绑定到当前 sandbox
- 对 host-local / worktree 后端可返回 `{ cwd, env }`；对 Docker / remote 后端可返回 adapter 内部封装后的 argv、exec target 或 launch descriptor
- 保持"谁决定何时执行"仍属于 `runtime/tasks` / `core/tool-scheduler`，sandbox 只提供正确进入环境的绑定信息

---

## 三、Non-Duties（非职责）

### 1. 不负责权限决策或审批执行

某个操作能不能执行，由 `core/policy` 做决策、`core/permission` 执行确认。sandbox 不调用 policy，也不弹窗。

### 2. 不负责 Run 或 Task 的生命周期台账

Run 的创建、取消、状态迁移由 `runtime/run-manager` 负责；后台任务的创建、输出读取、停止由 `runtime/tasks` 负责。sandbox 只提供它们运行时使用的环境上下文。

### 3. 不负责快照、diff 与回滚账本

checkpoint、patch、diff、revert 属于 `snapshot` 模块。sandbox 可以提供 `workdir`，但不维护"本轮改动了什么"的记录。

### 4. 不负责工具命令本身的调度与执行

具体何时执行工具、如何串行或并行调度、如何处理 tool result，由 `core/tool-scheduler` 和工具实现负责。sandbox 不直接调度工具，也不解释 tool result；它只提供让调用方进入正确环境的上下文或命令绑定。

### 5. 不负责把底层进程/线程抽象成公共模块

如果后台 shell task 需要持有 subprocess 句柄，应由 `runtime/tasks` 内部管理；如果容器或远程执行需要持有连接句柄，应由 sandbox adapter 内部管理。sandbox 不应额外再暴露一个公共的 `ProcessManager` 概念。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 被依赖 | run-manager 在启动 Run worker 前确保 session 对应的 sandbox context 已就绪 |
| `runtime/tasks` | 被依赖 | shell task 通过 sandbox context / command binding 进入当前 session 的执行环境 |
| `runtime/daemon` | 被持有 | daemon 初始化 SandboxManager 与 adapter registry，并在退出时协调清理 |
| `services/session` | 依赖 | 根据 session 与 project 关联信息解析 projectRoot、session 绑定关系 |
| `project` | 依赖 | 读取项目根目录、仓库信息、隔离能力约束等元数据 |
| `snapshot` | 间接依赖 | snapshot 使用 sandbox 提供的 workdir 做 checkpoint，但两者职责独立 |
| `core/tool-scheduler` | 间接依赖 | 工具执行层通过 sandbox context / command binding 获得工作目录或远程执行绑定，而非自行推断 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：run-manager 在启动 Run 前获取 sandbox context
```typescript
const sandboxContext = await sandboxManager.acquire(sessionId)

await runWorker.start({
  sessionId,
  runId,
  sandboxContext,
})
```

正确：TaskManager 用 sandbox context 决定 shell task 的启动绑定
```typescript
const context = await sandboxManager.getContext(sessionId)
const commandContext = await sandboxManager.resolveCommandContext(context, {
  command,
  args,
})

const child = spawn(commandContext.command, commandContext.args, {
  cwd: commandContext.cwd,
  env: commandContext.env,
})
```

正确：文件工具在访问路径前先让 sandbox 验证边界
```typescript
const target = await sandboxManager.validatePath(sessionId, requestedPath, {
  access: 'write',
})
```

### 5.2 职责外的示例

错误：sandbox 不应参与权限决策
```typescript
// 错误：不应该在 sandbox 中
if (policy.check(toolCall) === 'allow') {
  return context
}

// 正确：权限由 policy / permission 处理，sandbox 只返回执行上下文
```

错误：sandbox 不应实现变更快照
```typescript
// 错误：不应该在 sandbox 中
await sandbox.diffLastTurn(sessionId)

// 正确：diff / revert 由 snapshot 模块负责
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：sandbox 为每个 session 提供稳定的执行环境上下文，回答代码应当在哪里运行、如何进入该环境以及隔离边界是什么
- 能清楚回答"这个模块不该做什么"：不做权限决策、不做 Run/Task 台账、不做快照回滚、不调度工具、不解释命令结果、不暴露公共的进程句柄管理器
- 职责与其他模块无明显重叠：policy/permission（审批）、run-manager（运行台账）、tasks（后台任务）、snapshot（变更账本）边界清晰
