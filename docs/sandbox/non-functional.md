# sandbox 模块 non-functional.md

本文档定义 `sandbox` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，约束冲突时以此为准：

1. **路径边界的正确性**（首要）：sandbox 对工作区边界的承诺不能打折。`resolvePathForExisting()` / `resolvePathForWrite()` 必须在 realpath 后做真实的边界检查，symlink 穿透必须 fail-closed。任何情况下不允许将越界路径静默处理为合法路径。

2. **Lease 生命周期的完整性**：lease 引用计数必须正确，不能出现 leaseCount 为负、正常路径下 leaseCount 永久不归零、或强制 drain 后旧 lease 再次 release 导致状态污染的情况。

3. **acquire() 的 fail-fast 语义**：context 不存在时 acquire() 必须立即抛错，不自动创建 context，不挂起等待。这是消费方流程正确性的保障。

4. **Adapter 隔离性**：单个 adapter 的 create/destroy 失败不得影响其他 session 的 context 正常运行。

---

## 二、Operational Constraints（运行约束）

### acquire() 响应时间

`acquire()` 的主路径（注册表查找 + leaseCount++ + 构建 lease 对象）应为同步或接近同步的操作，不应有可感知延迟。任何有 I/O 的操作（如 adapter.create()）只发生在 `createContext()` 中，不在 `acquire()` 中。

### 路径 API 的 I/O 约束

- `resolvePath()` 必须是纯同步操作，不允许任何 I/O
- `resolvePathForExisting()` 和 `resolvePathForWrite()` 是 async，有 `fs.realpath()` 调用，适用于用户输入路径，不应出现在 per-turn 高频内循环中

### leaseCount 的并发安全

sandbox 运行在单进程单实例环境中（与 run-manager 相同约束），leaseCount 的 increment/decrement 通过 async 串行化或同步操作保证原子性，不依赖锁机制。

### createContext() 的 I/O 边界

`createContext()` 是有副作用的重操作：
- host-local: 验证 workdir 路径存在，至少一次 `fs.stat()`
- git-worktree (Phase 2): 执行 `git worktree add`，可能耗时数秒

`createContext()` 应在 session 建立阶段（不在 Run 关键路径）调用，不应因此延迟 RunWorker 启动。

### 崩溃后的 orphan 资源

进程崩溃时，`adapter.destroy()` 可能未执行，导致 worktree 或 container 残留。MVP（host-local）无残留问题；Phase 2 引入 git-worktree adapter 时，sandbox 应提供 `cleanupOrphanContexts()` 接口（或在 initialize() 中扫描残留资源），防止资源无限累积。

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- **路径越界静默通过**：`resolvePathForExisting()` 或 `resolvePathForWrite()` 对越界路径未抛 `SandboxBoundaryError` 而直接返回，不可接受
- **acquire() 对不存在的 context 自动创建**：隐藏上层流程 bug，不可接受
- **leaseCount 永久大于 0 导致 destroyContext() 永久阻塞**：应有 grace period + 强制 drain 兜底，不可接受无上限等待；强制 drain 后旧 lease 的 release 必须幂等无害

### 可接受的失败

- **adapter.create() 失败**：向调用方抛错，session 创建降级或提示用户。sandbox 不自行重试
- **adapter.destroy() 失败**：记录日志，context 从注册表移除，orphan 资源等待后续清理。不因清理失败阻塞 session 关闭
- **destroyContext() 时有残留 lease**：强制 drain 后继续销毁，记录告警日志

### 可观测性

- `createContext()` 调用应记录结构化日志（sessionId、adapterId、workdir）
- `destroyContext()` 调用应记录日志（sessionId、leaseCount at destroy time、是否强制 drain）
- `acquire()` / `release()` 可记录 debug 级日志（leaseCount 变化），不应有 info 级噪声
- `SandboxBoundaryError` 必须记录 warn 级日志，包含 sessionId、请求路径、workdir，便于识别潜在安全问题或 LLM 路径生成错误
- `SandboxContextNotFoundError` 应记录 error 级日志，说明上层流程可能未正确初始化 sandbox

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：多进程/分布式支持

sandbox 当前假设单进程单实例，leaseCount 通过内存原子操作维护。多进程扩展需要将 leaseCount 迁移至 DB 层（悲观锁或原子更新），当前阶段不实现。

### 当前不追求：跨 session 的全局资源配额

`SandboxManager` 不对活跃 context 总数设上限。全局资源控制（磁盘、worktree 数量、container 数量）是 Phase 2+ 的关注点，当前 session 数量可控。

### 当前不追求：adapter.create() 的重试机制

`createContext()` 失败后不自动重试。重试策略（是否重试、重试间隔）属于 session 层的责任，sandbox 不内嵌重试逻辑。

### 当前不追求：orphan 资源的自动清理

host-local adapter 无 worktree/container 等持久后端资源，orphan 问题不存在。`cleanupOrphanContexts()` 是 Phase 2（git-worktree adapter）引入时才需要实现的能力，MVP 阶段不实现。

### 当前不追求：路径 API 的性能优化

`resolvePathForExisting()` 不对 realpath 结果缓存。高频路径操作（如文件 glob）如需优化，应在消费方层做批量路径预校验，sandbox 不内置缓存。
