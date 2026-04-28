# sandbox 模块 architecture.md

本文档描述 `sandbox` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

sandbox 模块围绕三层分工展开：**管理层**（SandboxManager）、**上下文层**（SandboxContext + SandboxLease）、**适配层**（SandboxAdapter + AdapterRegistry）。

```
消费方（run-manager / tasks / 文件工具）
         │
         ▼
┌─────────────────────────────────────────────────┐
│ SandboxManager                                  │
│                                                 │
│ - context 注册表（Map<sessionId, Context>）     │
│ - lease 分发与引用计数                          │
│ - createContext / destroyContext / acquire       │
│ - ensureContext（daemon/bootstrap 专用）         │
└───────────────────┬─────────────────────────────┘
                    │ 使用
         ┌──────────┴──────────┐
         ▼                     ▼
┌──────────────────┐  ┌───────────────────────┐
│ SandboxContext   │  │ SandboxLease          │
│                  │  │                       │
│ session 级执行   │  │ per-task/run/snapshot │
│ 环境（生命周期   │  │ 访问凭证（短生命周期）│
│ 与 session 绑定）│  │                       │
└────────┬─────────┘  └───────────────────────┘
         │ 委托
         ▼
┌─────────────────────────────────────────────────┐
│ AdapterRegistry                                 │
│                                                 │
│ - 注册 / 查找 SandboxAdapter                    │
└───────────────────┬─────────────────────────────┘
                    │ 路由
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│HostLocal │  │GitWorktree│  │ Container... │
│ Adapter  │  │ Adapter   │  │ （Phase 3+）│
│ (Phase1) │  │ (Phase 2) │  └──────────────┘
└──────────┘  └──────────┘
```

### 主要组件职责

| 组件 | 职责 | 生命周期 |
|------|------|---------|
| `SandboxManager` | context 注册、lease 分发、引用计数管理 | daemon 全局单例 |
| `SandboxContext` | 持有工作区路径、adapter 引用、capabilities 元数据 | session 级（createContext → destroyContext）|
| `SandboxLease` | 路径 API、命令上下文获取、引用计数令牌 | task/run/tool 级（acquire → release）|
| `AdapterRegistry` | adapter 注册与查找，按 adapterId 路由 | 随 SandboxManager 初始化 |
| `SandboxAdapter`（接口） | 定义后端创建/销毁/能力声明的统一契约 | - |
| `HostLocalAdapter` | host-local MVP 实现：记录并验证 session workdir | Phase 1 |
| `GitWorktreeAdapter` | worktree 后端：创建/复用/销毁 worktree | Phase 2 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Strategy + Registry（可插拔后端）

`SandboxAdapter` 是 Strategy 接口，`AdapterRegistry` 是 Strategy 注册表。`SandboxManager` 根据 `createContext()` 传入的 `adapterId` 从注册表查找对应 adapter，委托其完成后端创建与销毁。

**选择理由**：
- 满足开闭原则（OCP）：新增后端（git-worktree、container、remote）只需实现 `SandboxAdapter` 接口并注册，不修改 `SandboxManager` 主逻辑
- 满足依赖倒置（DIP）：`SandboxManager` 依赖抽象接口而非具体后端实现
- MVP 只注册 `HostLocalAdapter`，不引入不必要的复杂度（YAGNI）

**不用 IoC 容器**：sandbox 的 adapter 数量有限（当前 1 个，Phase 2 为 2 个），手动注册更直接，无需引入容器框架。

### 2. Lease / Ref-count（租约引用计数）

`SandboxContext` 内部维护 `leaseCount`。`acquire()` 时 `leaseCount++`，`lease.release()` 时 `leaseCount--`。`destroyContext()` 在 `leaseCount > 0` 时须等待所有 lease 释放（或强制 drain）后再调用 `adapter.destroy()`。

**选择理由**：
- 同一 session 下的多个并发 task/run/snapshot 可以安全共享同一 context，无需重复创建
- 确保 git-worktree 等有副作用的后端不在有消费者时提前销毁
- 语义清晰：acquire/release 显式声明资源持有边界

### 3. 显式生命周期（Explicit Lifecycle）

`createContext()` 显式创建，`destroyContext()` 显式销毁，`acquire()` 不产生副作用（context 不存在时 fail-fast）。

**选择理由**：
- 避免懒创建将"创建执行环境"这一重副作用隐藏在 `acquire()` 中
- daemon 启动顺序明确：sandbox 初始化与 session 关联在 session 创建阶段显式发生
- 错误来源清晰：`SandboxContextNotFoundError` 意味着"session 没有初始化 sandbox"，而不是"后端创建失败"
- `ensureContext()`（daemon/bootstrap 便捷方法）是受控的例外，不作为核心路径的默认语义

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/sandbox/
├── index.ts                   # 公共接口：导出 SandboxManager、类型、错误
├── manager.ts                 # SandboxManager 类：context 注册表、lease 分发
├── context.ts                 # SandboxContext 类型与内部状态管理
├── lease.ts                   # SandboxLease 实现：路径 API、CommandContext
├── adapter-registry.ts        # AdapterRegistry：注册与查找
├── types.ts                   # 公共类型：SandboxCapabilities、CommandContext、路径别名
├── errors.ts                  # sandbox 错误类型：SandboxContextNotFoundError 等
│
├── adapters/
│   ├── host-local.ts          # HostLocalAdapter（Phase 1 MVP）
│   └── git-worktree.ts        # GitWorktreeAdapter（Phase 2，占位或实现）
│
└── __tests__/
    ├── manager.test.ts
    ├── lease.test.ts
    └── adapters/
        └── host-local.test.ts
```

### 文件职责定位

| 文件 | 定位 | 对外稳定性 |
|------|------|-----------|
| `index.ts` | 公共接口 | 稳定，仅导出消费方需要的类型和类 |
| `manager.ts` | 核心逻辑 | 稳定接口，内部实现可演进 |
| `lease.ts` | 路径 API 实现 | 稳定（接口），实现随后端演进 |
| `adapter-registry.ts` | 后端路由 | 稳定接口，内部索引结构可变 |
| `adapters/host-local.ts` | Phase 1 后端 | 内部实现，接口稳定 |
| `adapters/git-worktree.ts` | Phase 2 后端 | 占位，接口与 host-local 对齐 |
| `errors.ts` | 错误类型 | 稳定，消费方依赖这些类型做错误处理 |
| `types.ts` | 共享类型 | 稳定，跨模块引用 |

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. 路径 API 分层：字符串检查 + 可选 realpath

`SandboxLease` 提供三个路径 API，按安全级别分层：

- `resolvePath(rel)` — 同步字符串规范化，不做 I/O
- `resolvePathForExisting(rel)` — 使用 `realpath(target)`，async
- `resolvePathForWrite(rel)` — 使用 `realpath(parentDir) + basename`，async

**为什么不把 realpath 放进 resolvePath()**：`realpath()` 需要目标路径存在，且有 I/O 开销；写入路径的目标通常尚不存在。强行合并会让路径解析行为不一致且难以预测。

**代价**：消费方需要根据操作类型选择正确的 API，存在误用风险。缓解方式：文档明确说明使用规则，API 命名尽量自描述（`ForExisting` / `ForWrite`）。

**symlink 策略 fail-closed**：realpath 解析后如果路径在 `workdir` 外，抛 `SandboxBoundaryError`，不降级为字符串检查。

### 2. 不在 SandboxLease 上放 exec()

命令执行仍归 `runtime/tasks`（进程生命周期、SIGTERM/SIGKILL、stdout/stderr）。sandbox 提供 `resolveCommandContext()` 返回 `CommandContext`（cwd/env + 未来的 launch descriptor），由 tasks 使用该上下文决定如何 spawn。

**放弃的方案**：`lease.exec(cmd, args)` 代理命令执行。原因：会导致 sandbox 与 tasks 职责重叠，timeout/SIGKILL/OutputStore 写入由谁负责无法清晰划分。

### 3. MVP 不做跨 session 资源限制

`SandboxManager` 不对全局同时存在的 context 数量设上限。session 数量控制由 `services/session` / daemon 层负责。引入全局资源限制是 Phase 2+ 的暂缓项。
