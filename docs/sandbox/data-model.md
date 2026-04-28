# sandbox 模块 data-model.md

本文档定义 `sandbox` 模块的核心概念与数据模型。目标是统一模块内部和消费方对这些概念的认知语言。

---

## 一、Core Concepts（核心概念）

### SandboxContext

**session 级执行环境**。每个 session 对应一个 `SandboxContext`，由 `SandboxManager.createContext()` 显式创建，与 session 生命周期绑定。

Context 回答的问题：代码应该在哪个目录里运行？使用什么后端（host-local / worktree / container）？这个执行环境有哪些能力？

Context 不是轻量对象——对于 git-worktree 后端，创建 context 意味着创建（或复用）一个 worktree；对于 container 后端，意味着 attach 容器。因此 context 的生命周期必须显式管理，不能按需懒创建。

### SandboxLease

**per-task / per-run / per-tool 的访问凭证**。每次消费方（tasks、RunWorker、文件工具）需要访问工作区时，通过 `sandboxManager.acquire(sessionId)` 获取一个 lease。

Lease 是引用计数令牌：`acquire()` 使 `context.leaseCount++`，`release()` 使 `context.leaseCount--`。这确保在有活跃消费方时，context 不会被提前销毁。

Lease 暴露的核心能力：
- 路径 API（`resolvePath` / `resolvePathForExisting` / `resolvePathForWrite`）
- 命令上下文（`resolveCommandContext()`）
- 工作区元数据（`workdir`、`capabilities`）

### SandboxAdapter

**后端实现契约**。定义创建/销毁执行环境的统一接口。不同后端（host-local、git-worktree、container）实现同一个 `SandboxAdapter` 接口，`SandboxManager` 不感知后端差异。

Adapter 内部可持有后端特定句柄（worktree 路径、container id、ssh 连接），但这些句柄不对外暴露。

### SandboxCapabilities

**执行环境的能力声明**。描述当前 context 支持什么操作（是否强隔离、是否可执行命令、是否支持 git 操作等）。供 policy / permission / tools 做更细粒度判断。

### CommandContext

**命令执行绑定描述**。`SandboxLease.resolveCommandContext()` 返回的数据结构，告诉 tasks 模块命令应如何在当前 sandbox 环境中启动。对于 host-local 是 `{ cwd, env }`；对于 container 未来可能是 launch descriptor。

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| `SandboxContext` | Entity | 有身份（contextId / sessionId），有生命周期，被 SandboxManager 持有 |
| `SandboxLease` | Entity | 有身份（leaseId），有生命周期（acquire → release），持有对 context 的引用 |
| `SandboxAdapter` | 接口/策略 | 无状态接口，具体 adapter 实例由 AdapterRegistry 持有 |
| `SandboxCapabilities` | Value Object | 不可变的能力描述，随 context 创建时确定 |
| `CommandContext` | Value Object | `resolveCommandContext()` 返回的快照，不可变 |

---

## 三、Key Data Fields（关键数据字段）

### SandboxContext

```typescript
interface SandboxContext {
  contextId: string           // 全局唯一 ID（由 SandboxManager 生成）
  sessionId: string           // 关联的 session
  adapterId: string           // 使用的 adapter（'host-local' | 'git-worktree' | ...）
  workdir: string             // 绝对路径，任务执行的工作目录
  capabilities: SandboxCapabilities
  status: 'active' | 'destroying' | 'destroyed'
  createdAt: number           // Unix timestamp ms
  leaseCount: number          // 活跃 lease 数量，由 SandboxManager 维护
}
```

### SandboxLease

```typescript
interface SandboxLease {
  sessionId: string
  contextId: string
  adapterId: string
  workdir: string             // 来自 context，快照值
  capabilities: SandboxCapabilities

  // 路径 API
  resolvePath(rel: string): string                        // 同步，字符串规范化
  resolvePathForExisting(rel: string): Promise<string>    // realpath(target)
  resolvePathForWrite(rel: string): Promise<string>       // realpath(parentDir) + basename

  // 命令绑定
  resolveCommandContext(opts?: CommandContextOptions): CommandContext

  release(): Promise<void>
}
```

### SandboxCapabilities

```typescript
interface SandboxCapabilities {
  isolation: 'none' | 'worktree' | 'container' | 'remote'
  canExecCommands: boolean    // 是否支持通过 CommandContext 执行命令
  supportsGit: boolean        // adapter 是否具备 git-aware 能力（Phase 2）
  readOnly: boolean           // 整个 context 是否只读（某些受限场景）
}
```

**host-local adapter 的 capabilities（MVP）**：
```typescript
{ isolation: 'none', canExecCommands: true, supportsGit: false, readOnly: false }
```

### CommandContext

```typescript
interface CommandContext {
  kind: 'host-local' | 'worktree' | 'container' | 'remote'
  cwd: string
  env?: Record<string, string>
  commandPrefix?: string[]    // 未来 container 时的前缀（如 ['docker', 'exec', containerId]）
}
```

---

## 四、Lifecycle & Ownership（生命周期与归属）

```
daemon 初始化
  → AdapterRegistry 注册 adapters

session 创建 / attach project
  → sandboxManager.createContext(sessionId, { adapterId, workdir })
  → adapter.create(sessionId, options) → AdapterHandle
  → SandboxContext { status: 'active', leaseCount: 0 } 存入注册表

tasks / RunWorker / snapshot 访问工作区
  → sandboxManager.acquire(sessionId) → SandboxLease（leaseCount++）

消费方结束
  → lease.release()（leaseCount--）

session close / reset / project switch
  → sandboxManager.destroyContext(sessionId)
  → 等待 leaseCount 归零（或 grace period 后强制 drain）
  → adapter.destroy(handle)
  → SandboxContext { status: 'destroyed' }，从注册表移除
```

**所有权规则**：
- `SandboxContext` 的所有权归 `SandboxManager`
- `SandboxLease` 的所有权归消费方（task runner / RunWorker / 文件工具），消费方负责调用 `release()`
- `AdapterHandle`（后端句柄）归对应 adapter 内部，不对外暴露

---

## 五、错误类型（Error Taxonomy）

| 错误 | 触发条件 | 消费方处理 |
|------|---------|-----------|
| `SandboxContextNotFoundError` | `acquire()` 时 session 无对应 active context（不存在、destroying 或 destroyed） | 上层应确保 session 已 createContext 且未关闭 |
| `SandboxContextAlreadyExistsError` | 重复 `createContext()` 同一 sessionId | 上层应检查或使用 ensureContext() |
| `SandboxBoundaryError` | 路径解析后在 workdir 外，或 symlink 穿透 | 消费方不应假设越界路径合法 |
| `SandboxAdapterError` | adapter 后端创建/销毁失败 | 传播给 session 创建流程处理 |

`destroyContext()` 遇到活跃 lease 时不直接抛业务错误，而是进入 `destroying` 状态并等待 lease drain；超过 grace period 后可强制 drain 并记录告警。`ArtifactNotAvailableError` 不属于 sandbox 层，属于 snapshot/store。
