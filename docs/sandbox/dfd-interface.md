# sandbox 模块 dfd-interface.md

本文档描述 `sandbox` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

sandbox 是平台级基础设施模块，与以下模块发生数据交换：

| 方向 | 外部模块 | 交互方式 |
|------|---------|---------|
| 被持有 | `runtime/daemon` | daemon 初始化 SandboxManager + AdapterRegistry，退出时协调销毁所有 context |
| 被调用 | `runtime/run-manager` | RunWorker 在启动前 acquire lease，结束后 release |
| 被调用 | `runtime/tasks` | workspace-bound task 启动前 acquire lease，结束后 release |
| 间接协作 | `snapshot` | snapshot 接收上层传入的 workdir；sandbox 启动时该 workdir 可来自 SandboxLease，但 snapshot 不直接 acquire/release lease |
| 依赖 | `services/session` / `project` | 解析 sessionId → workdir（由 daemon/session 层在 createContext 时传入）|

**讨论范围**：本文档关注 SandboxManager 的公共接口和主要数据流。不涉及 adapter 内部的 worktree/container 实现细节。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：初始化（daemon 启动）

```
daemon.bootstrap
  → adapterRegistry.register('host-local', new HostLocalAdapter())
  → adapterRegistry.register('git-worktree', new GitWorktreeAdapter())  // Phase 2
  → sandboxManager = new SandboxManager({ adapterRegistry })
  → sandboxManager.initialize()

输出：SandboxManager 就绪，可接受 createContext() 调用
```

### 流程 2：Session 创建 → Context 建立

```
services/session 或 daemon（session attach / project 打开）
  → sandboxManager.createContext(sessionId, {
      adapterId: 'host-local',
      workdir: resolvedWorkdir,
    })
  ↓
SandboxManager 查找 AdapterRegistry → HostLocalAdapter
  ↓
adapter.create(sessionId, options) → AdapterHandle { workdir, metadata }
  ↓
SandboxContext { contextId, sessionId, adapterId, workdir, capabilities, status: 'active', leaseCount: 0 }
  存入内存注册表
  ↓
输出：SandboxContext（供调用方确认，通常不需要保存引用）
```

若 context 已存在，抛 `SandboxContextAlreadyExistsError`（除非使用 `ensureContext()`）。

### 流程 3：RunWorker 获取工作区访问权

```
run-manager（RunWorker.start() 阶段）
  → sandboxManager.acquire(sessionId)
  ↓
SandboxManager 查找 context（不存在 → SandboxContextNotFoundError）
  ↓
leaseCount++
  ↓
构建 SandboxLease（包含 workdir、capabilities、路径 API、commandContext 方法）
  ↓
输出：SandboxLease → 注入到 RunWorker context / lifecycle

RunWorker 完成（succeeded / failed / cancelled）
  → lease.release()
  → leaseCount--
```

### 流程 4：Task 获取命令执行上下文

```
runtime/tasks（ShellTaskRunner.start()，fileAccess = 'workspace-ro' 或 'workspace-rw'）
  → sandboxManager.acquire(sessionId) → SandboxLease
  ↓
lease.resolveCommandContext({ fileAccess })
  → CommandContext { kind: 'host-local', cwd: workdir, env: {...} }
  ↓
ShellTaskRunner 使用 cwd/env 作为 child_process.spawn 参数
  ↓
task 结束 → lease.release()
```

`fileAccess = 'none'` 的 task 不调用 acquire，不持有 lease。

### 流程 5：路径验证（文件工具 / 持 lease 的执行方）

```
消费方（文件工具 / 持 lease 的执行方）持有 SandboxLease
  ↓
用户输入路径 / LLM 生成路径
  → lease.resolvePathForExisting(userInputPath)
    → path.resolve(workdir, rel) → realpath(target)
    → 若 realpath 结果在 workdir 外 → 抛 SandboxBoundaryError（fail-closed）
    → 返回安全绝对路径

写入路径
  → lease.resolvePathForWrite(userInputPath)
    → realpath(parentDir) + basename
    → 边界检查 → 返回安全绝对路径

内部已知安全路径
  → lease.resolvePath(rel)
    → 同步字符串 resolve + normalize（无 I/O）
```

### 流程 6：Session 关闭 → Context 销毁

```
session close / reset / project switch
  → sandboxManager.destroyContext(sessionId)
  ↓
检查 leaseCount：
  - leaseCount = 0 → 立即销毁
  - leaseCount > 0 → 等待 lease 自然释放（或 grace period 后强制 drain）
  ↓
adapter.destroy(handle)
  （host-local: no-op；git-worktree: 删除 worktree；container: stop/remove）
  ↓
context.status = 'destroyed'，从注册表移除

daemon 关闭时：先停止所有消费方（tasks.stopAll / runManager.cancelAll），再 destroyContext 所有 session
```

---

## 三、Interface Definition（接口定义）

### SandboxManager 公共接口

**`createContext(sessionId, options)`**
- 输入：sessionId、adapterId、workdir（由上层从 session/project 解析后传入）
- 输出：`SandboxContext`
- 异步：是（adapter.create() 可能有 I/O）
- 失败：`SandboxContextAlreadyExistsError` / `SandboxAdapterError`

**`destroyContext(sessionId)`**
- 语义：销毁 context，等待 lease drain 后调用 adapter.destroy()
- 异步：是
- 失败：sessionId 不存在时幂等返回；adapter.destroy() 失败时记录 orphan 资源并传播或按调用方策略处理

**`ensureContext(sessionId, options)`**
- 语义：若 context 不存在则创建，已存在则直接返回
- 使用限制：仅供 daemon/bootstrap 装配层使用，不作为通用 API

**`acquire(sessionId)`**
- 输入：sessionId
- 输出：`SandboxLease`（leaseCount++）
- 异步：是（微小）
- 失败：active context 不存在（不存在、destroying、destroyed）→ `SandboxContextNotFoundError`（fail-fast，不自动创建）

**`getContext(sessionId)`**
- 输出：`SandboxContext | undefined`
- 同步：是
- 用途：查询当前 context 状态（workdir、capabilities、leaseCount）

### SandboxLease 公共接口

**`resolvePath(rel)`** — 同步，字符串 normalize；仅用于内部已知安全路径

**`resolvePathForExisting(rel)`** — async，`realpath(target)`；用于读取已存在的文件

**`resolvePathForWrite(rel)`** — async，`realpath(parentDir) + basename`；用于写入/创建目标

**`resolveCommandContext(opts?)`** — 同步（host-local）或快速查找；返回 `CommandContext`

**`release()`** — async，leaseCount--；消费方必须在任务结束后调用（无论成功/失败）

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建方 | 所有者 | 责任边界 |
|------|-------|-------|---------|
| `SandboxContext` | `sandboxManager.createContext()` | SandboxManager | 注册表内持有；消费方不直接持有 context 引用，通过 lease 访问 |
| `AdapterHandle`（后端句柄）| `adapter.create()` | adapter 内部 | 不对外暴露；destroy 时由 adapter 负责清理 |
| `SandboxLease` | `sandboxManager.acquire()` | 消费方（task / RunWorker / 文件工具）| 消费方负责调用 `release()`；泄漏 lease 会导致 context 无法销毁 |
| `workdir` 路径 | session / project 层（传入 createContext）| SandboxContext | sandbox 只存储和验证，不决定具体路径 |
| `CommandContext` | `lease.resolveCommandContext()` | 消费方（tasks）| Value Object，调用方按需使用，sandbox 不追踪其使用情况 |
| `SandboxCapabilities` | `adapter.getCapabilities()` | SandboxContext（快照值）| adapter 声明，context 快照，lease 透传；消费方只读 |
