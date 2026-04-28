# sandbox 模块 test.md

本文档说明如何验证 `sandbox` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- Context 生命周期：createContext / destroyContext / ensureContext 的正确行为
- Lease 引用计数：acquire / release 的计数正确性
- acquire() 的 fail-fast 语义：context 不存在时立即抛错
- 路径 API：resolvePath 的字符串边界检查；resolvePathForExisting / resolvePathForWrite 的 realpath 边界验证；symlink 穿透检测
- CommandContext：resolveCommandContext() 返回正确的 cwd/env
- destroyContext() 的 lease drain：有活跃 lease 时的等待与强制 drain
- Adapter 委托：createContext / destroyContext 正确调用 adapter.create / adapter.destroy
- SandboxBoundaryError：所有越界路径场景均 fail-closed

**不覆盖**：
- HostLocalAdapter 的具体文件系统操作（属于 adapter 单元测试范围）
- GitWorktreeAdapter 内部的 git 命令执行（属于 Phase 2 adapter 测试）
- tasks / run-manager / 文件工具内部的 lease 使用逻辑（属于消费方测试）
- policy / permission 的权限决策（不由 sandbox 负责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：Context 生命周期

| 场景 | 预期结果 |
|------|---------|
| createContext() 成功 | context 进入注册表，status = 'active'，leaseCount = 0 |
| 同一 sessionId 重复 createContext() | 抛 SandboxContextAlreadyExistsError，注册表不变 |
| ensureContext() context 不存在 | 创建并返回，等同 createContext() |
| ensureContext() context 已存在 | 直接返回已有 context，不重复创建 |
| destroyContext() leaseCount = 0 | 立即调用 adapter.destroy()，context 从注册表移除 |
| destroyContext() leaseCount > 0 | 等待 lease 释放后再销毁；超过 grace period 时强制 drain，旧 lease 后续 release 幂等无害 |
| destroyContext() 不存在的 sessionId | 幂等返回，不调用 adapter.destroy() |

### 场景组 2：Lease 引用计数

| 场景 | 预期结果 |
|------|---------|
| acquire() context 存在 | 返回 SandboxLease，leaseCount = 1 |
| 两次 acquire() 同一 session | 两个独立 lease，leaseCount = 2 |
| acquire() context 不存在 | 抛 SandboxContextNotFoundError，leaseCount 不变 |
| lease.release() | leaseCount-- |
| 两个 lease 均 release() | leaseCount 归零 |
| destroyContext() 时 leaseCount = 0 | 立即销毁 |
| destroyContext() 时 leaseCount = 1，然后 lease.release() | release 后自动完成销毁流程 |
| 强制 drain 后旧 lease 再 release() | 不应使 leaseCount 为负，不应重新打开 context |

### 场景组 3：路径边界验证

| 场景 | API | 预期结果 |
|------|-----|---------|
| 合法相对路径 | resolvePath('src/main.ts') | 返回 workdir + '/src/main.ts' |
| 路径穿越（字符串层）| resolvePath('../../etc/passwd') | 抛 SandboxBoundaryError |
| 合法文件（存在）| resolvePathForExisting('README.md') | 返回 realpath 绝对路径 |
| symlink 指向 workdir 外 | resolvePathForExisting('evil_link') | 抛 SandboxBoundaryError |
| symlink 指向 workdir 内 | resolvePathForExisting('internal_link') | 允许，返回实际路径 |
| 写入合法路径 | resolvePathForWrite('out/result.txt') | 返回父目录 realpath + basename |
| 写入父目录为 symlink 穿透 | resolvePathForWrite('evil_dir/file.txt') | 抛 SandboxBoundaryError |
| 绝对路径在 workdir 内 | resolvePath('/abs/path/in/workdir') | 通过（前缀检查） |
| 绝对路径在 workdir 外 | resolvePath('/etc/passwd') | 抛 SandboxBoundaryError |

### 场景组 4：CommandContext

| 场景 | 预期结果 |
|------|---------|
| host-local adapter，resolveCommandContext() | 返回 { kind: 'host-local', cwd: workdir, env: {...} } |
| cwd 与 context.workdir 一致 | cwd 精确等于 createContext() 时传入的 workdir |

---

## 三、Integration Points（集成点测试）

### 集成点 1：sandbox + 真实文件系统（集成测试）

**验证重点**：`resolvePathForExisting()` 和 `resolvePathForWrite()` 的 realpath 逻辑在真实文件系统上的正确性，包括 symlink 穿透场景

**方式**：使用临时目录（`os.tmpdir()` + 唯一后缀），在测试中创建真实 symlink，验证 sandbox 能正确识别并拒绝穿透路径

**关注**：
- Windows junction / Windows symlink 的 realpath 行为与 Unix symlink 是否一致
- `resolvePathForWrite()` 的父目录 realpath 在目标不存在时的行为（父目录存在 vs 父目录也不存在）

### 集成点 2：sandbox + fake adapter（单元测试）

**验证重点**：SandboxManager 正确委托 adapter.create() / adapter.destroy()，并在 context 生命周期各阶段调用正确的 adapter 方法

**方式**：fake SandboxAdapter（记录调用次数和参数，可配置 create/destroy 失败），断言：
- createContext() 调用 adapter.create() 一次
- destroyContext() 在 lease drain 后调用 adapter.destroy() 一次
- adapter.create() 失败时，context 不进入注册表

### 集成点 3：sandbox + tasks（集成测试，跨模块）

**验证重点**：tasks 的 workspace-bound runner 通过 sandbox acquire/release 租约，任务结束后 leaseCount 正确归零

**方式**：使用真实 TaskManager + 真实 SandboxManager（host-local adapter + tmpdir），创建 shell task 完成后检查 leaseCount

**关注**：task 异常退出（抛错）时 lease 是否仍被正确 release

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）+ 文件系统集成测试（integration）

**单元测试覆盖**（使用 fake adapter）：
- Context 生命周期（createContext / destroyContext / ensureContext）
- Lease 引用计数（acquire / release 的正确计数）
- acquire() fail-fast 语义
- resolvePath() 字符串边界检查（纯逻辑，无 I/O）
- destroyContext() 的 lease drain 逻辑

**Mock 范围**（unit 层）：
- `SandboxAdapter` → fake adapter（记录调用，可配置成功/失败）
- 不 mock `SandboxManager` / `SandboxLease` 内部逻辑（这是被测对象）

**集成测试覆盖**（真实文件系统 + tmpdir）：
- `resolvePathForExisting()` 的 realpath + 边界检查（含 symlink 穿透场景）
- `resolvePathForWrite()` 的父目录 realpath + 边界检查
- 跨平台路径行为验证（Windows junction 等）

**不 mock**（integration 层）：`fs.realpath()`、真实 symlink 创建

### 关注点：symlink 穿透的平台差异

symlink 测试必须在 Windows 和 Unix 下分别验证，因为：
- Windows 的 junction 与 symlink 的 `realpath()` 行为可能不同
- Windows 的大小写不敏感路径可能影响前缀匹配逻辑

### 关注点：lease drain 的时序

destroyContext() 的 lease drain 测试需要构造真正的并发场景（lease 在 destroyContext() 调用后才 release），验证 destroy 等待而不是立即执行。使用 `Promise.all([destroyContext(), delayedRelease()])` 构造时序。

### 关注点：adapter 失败的隔离性

adapter.create() 失败的测试需要断言：
- 其他 session 的 createContext() 不受影响
- 失败的 session 再次 createContext() 可以成功（注册表未污染）
