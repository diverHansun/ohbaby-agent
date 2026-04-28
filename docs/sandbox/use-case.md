# sandbox 模块 use-case.md

本文档描述 `sandbox` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Establish Session Sandbox | session 创建 / project attach | Context 建立、adapter 委托、注册表登记 |
| UC2 | Acquire and Use Sandbox Lease | tasks / RunWorker / 文件工具 | Lease 分发、路径验证、命令上下文提供 |
| UC3 | Destroy Session Sandbox | session close / reset / project switch | Lease drain、adapter 销毁、注册表清理 |
| UC4 | Validate Path Boundary | 文件工具 / 持 lease 的执行方 | 路径规范化、symlink 穿透检测、边界 fail-closed |

---

## 二、Main Flow Description（主流程描述）

### UC1：Establish Session Sandbox

session 创建或 attach project 时，由上层（daemon bootstrap / session 服务）显式建立执行环境。

```
输入：createContext(sessionId, { adapterId, workdir })
  ↓
1. 检查注册表
   → 若 sessionId 已有 context → 抛 SandboxContextAlreadyExistsError
   → 若无 → 继续
  ↓
2. 查找 adapter
   → adapterRegistry.get(adapterId)
   → 若 adapter 未注册 → 抛 SandboxAdapterError
  ↓
3. 委托 adapter 创建后端
   → adapter.create(sessionId, { workdir, ... }) → AdapterHandle
   （host-local: 验证路径存在并记录；git-worktree: 创建/复用 worktree）
  ↓
4. 构建 SandboxContext
   → { contextId, sessionId, adapterId, workdir, capabilities, status: 'active', leaseCount: 0 }
  ↓
5. 存入注册表
  ↓
输出：SandboxContext；可立即接受 acquire() 调用
```

**注意**：`ensureContext()` 是 UC1 的幂等变体，内部先检查注册表，存在则直接返回，不存在则执行 UC1。仅供 daemon/bootstrap 调用。

---

### UC2：Acquire and Use Sandbox Lease

tasks、RunWorker、文件工具需要访问工作区时，通过 acquire 获取短期访问凭证。snapshot 不直接 acquire lease；如果当前运行启用了 sandbox，run worker 可从 lease 中取出 workdir 后传给 snapshot。

```
输入：acquire(sessionId)
  ↓
1. 查找 context
   → 注册表中查找 sessionId
   → 未找到 → SandboxContextNotFoundError（fail-fast，不自动创建）
   → status != 'active' → SandboxContextNotFoundError
  ↓
2. 增加引用计数
   → context.leaseCount++
  ↓
3. 构建 SandboxLease
   → { sessionId, contextId, adapterId, workdir, capabilities, 路径 API, release }
  ↓
输出：SandboxLease → 消费方持有

消费方使用 lease 期间：
  ├── lease.resolvePath(rel)            → 同步字符串路径
  ├── lease.resolvePathForExisting(rel) → async realpath 安全路径
  ├── lease.resolvePathForWrite(rel)    → async 写入安全路径
  └── lease.resolveCommandContext()     → CommandContext { cwd, env, ... }

消费方结束（无论成功/失败）：
  → lease.release()
  → context.leaseCount--
```

---

### UC3：Destroy Session Sandbox

session 关闭、显式 reset 或切换 project 时，显式销毁执行环境。

```
输入：destroyContext(sessionId)
  ↓
1. 查找 context
   → 未找到 → 幂等返回
  ↓
2. 标记 destroying
   → context.status = 'destroying'（阻止新 acquire 进入）
  ↓
3. 等待 lease drain
   → 若 leaseCount > 0：
     ├── 等待所有 lease 自然释放（消费方正常结束）
     └── 超过 grace period → 强制 drain（记录日志，触发告警，并使后续 release 幂等无害）
  ↓
4. 委托 adapter 销毁
   → adapter.destroy(handle)
   （host-local: no-op；git-worktree: 删除 worktree；container: stop/remove）
  ↓
5. 从注册表移除
   → context.status = 'destroyed'
  ↓
输出：context 彻底清理；资源释放
```

**daemon 关闭时的顺序**：
1. `heartbeat.stop()` / `scheduler.stop()`
2. `runManager.cancelAll()` → 所有 RunWorker 结束并 release lease
3. `taskManager.stopAll()` → 所有 task 结束并 release lease
4. 遍历所有 context → `sandboxManager.destroyContext(sessionId)`

---

### UC4：Validate Path Boundary

消费方（文件工具、持 lease 的执行方）在访问文件前，通过 lease 的路径 API 做边界验证。

```
场景：文件工具收到用户 / LLM 输入的路径 'evil_link'

读取路径：
  → lease.resolvePathForExisting('evil_link')
    1. path.resolve(workdir, 'evil_link') → '/home/user/project/evil_link'
    2. fs.realpath('/home/user/project/evil_link') → '/etc/passwd'  （symlink 穿透）
    3. '/etc/passwd' 不以 workdir 为前缀 → 抛 SandboxBoundaryError

写入路径（目标文件可能不存在）：
  → lease.resolvePathForWrite('new_dir/new_file.txt')
    1. path.resolve(workdir, 'new_dir/new_file.txt') → '/home/user/project/new_dir/new_file.txt'
    2. 分离 parentDir = '/home/user/project/new_dir'
    3. fs.realpath('/home/user/project/new_dir') → 检查父目录（若不存在，可 mkdir 后 realpath）
    4. 边界检查通过 → 返回 '/home/user/project/new_dir/new_file.txt'

内部已知安全路径（如 artifact 存放）：
  → lease.resolvePath('artifacts/output.txt')
    1. path.resolve(workdir, 'artifacts/output.txt') → 字符串规范化
    2. 前缀检查（字符串层）
    3. 返回规范化绝对路径（无 I/O）
```

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| workdir 的解析（项目目录来自哪里）| session / project 层 | 由调用方在 createContext 时传入，sandbox 只存储和验证 |
| adapter 注册与选择策略 | daemon/bootstrap + AdapterRegistry | daemon 决定注册哪些 adapter；createContext 时由调用方指定 adapterId |
| 路径 API 实现（resolvePath / realpath）| sandbox（SandboxLease）| 统一实现，消费方不自行拼接路径 |
| 命令执行（spawn / SIGTERM / stdout）| runtime/tasks | sandbox 只提供 CommandContext，不执行命令 |
| 权限决策（能否访问某路径）| core/policy + core/permission | sandbox 只做物理边界检查，不做业务权限判断 |
| lease 释放的时机 | 消费方（task / RunWorker / 文件工具）| 消费方负责在任务结束后调用 release() |
| context 销毁时机 | session / daemon | sandbox 不自行决定何时销毁 context |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：acquire() 时 context 不存在的处理

**策略**：fail-fast，抛 `SandboxContextNotFoundError`，不自动创建 context。

**理由**：context 不存在通常意味着上层流程（session 创建、project attach）没有正确初始化。自动创建会掩盖这一错误，且懒创建将"重副作用操作"（worktree 创建等）隐藏在 acquire() 里，导致错误诊断困难。

### 决策点 2：symlink 穿透的处理

**策略**：fail-closed。`resolvePathForExisting()` / `resolvePathForWrite()` 在 realpath 解析后如果路径在 workdir 外，抛 `SandboxBoundaryError`，不降级为字符串检查。

**理由**：sandbox 的核心承诺是工作区边界隔离。边界检查降级为静默绕过会让这一承诺完全失效，且 coding agent 场景存在真实的 symlink 攻击面（处理外部仓库、运行用户脚本）。

### 失败点 1：adapter.create() 失败

**场景**：host-local 的 workdir 路径不存在；git-worktree adapter 创建 worktree 失败

**预期行为**：`createContext()` 抛 `SandboxAdapterError`，不写入注册表。调用方（session 服务）负责向用户提示或降级处理。

### 失败点 2：destroyContext() 时 lease 未释放

**场景**：消费方意外崩溃或代码 bug 导致 `lease.release()` 未被调用

**预期行为**：`destroyContext()` 等待 grace period 后强制 drain，记录结构化日志（含 leaseCount、sessionId），继续执行 adapter.destroy()。sandbox 不因消费方 bug 而永久阻塞 session 关闭。

### 失败点 3：adapter.destroy() 失败

**场景**：git-worktree 删除失败（文件被锁定等）

**预期行为**：记录日志，context 从注册表移除（不阻塞后续操作），遗留资源标记为 orphan，等待下次启动时的 cleanup 逻辑处理。sandbox 不因清理失败而影响 session 生命周期。
