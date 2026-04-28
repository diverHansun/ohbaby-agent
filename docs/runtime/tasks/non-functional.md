# tasks 模块 non-functional.md

本文档定义 `runtime/tasks` 模块在功能之外必须满足的工程约束。

---

## 一、Quality Priorities（质量优先级）

按重要性排序，当约束冲突时以此为准：

1. **SandboxLease 的无泄漏释放**（首要）：SandboxLease 必须在任何退出路径下（正常完成、failed、cancelled、timeout、panic）被释放。泄漏 SandboxLease 会耗尽 sandbox 资源池，影响整个 runtime 的文件访问能力。

2. **subprocess 的无泄漏终止**：ShellTaskRunner 停止后，关联的 subprocess 必须被终止（SIGTERM → SIGKILL），不允许孤儿进程继续运行。孤儿进程会继续占用系统资源，且可能继续写 workspace，超出预期范围。

3. **fileAccess 声明的强制性**：`workspace-rw` 必须显式声明，不允许运行时推断。这是安全边界，不可因为"方便"而放宽。

---

## 二、Operational Constraints（运行约束）

### SIGTERM → SIGKILL 等待时间

- ShellTaskRunner.stop() 发送 SIGTERM 后，等待 subprocess 退出的超时时间需要在实现阶段明确（建议 5 秒）
- 超时后发送 SIGKILL 强制终止，不再等待
- 等待时间不应过短（给 subprocess 机会做清理）；也不应过长（daemon 关闭时 stopAll() 的总等待时间不可控）

### subprocess 数量与资源

- 当前阶段不对全局 subprocess 数量设硬上限；shell task 数量由上层（lifecycle / agent 工具）控制
- 每个 subprocess 继承父进程的部分环境，SandboxLease 限定文件系统访问范围；CPU 和内存不做额外限制
- workspace-rw task 对 workspace 的修改是永久的（不自动回滚）；调用方有责任控制写入范围

### SandboxLease 获取超时

- sandboxManager.acquire() 应有超时限制，不允许无限等待（sandbox 资源不足时挂起整个 task 创建路径）
- 若 acquire() 超时，task 以 failed 状态返回，不启动 subprocess
- 具体超时时间在实现阶段明确

### daemon 关闭时的 stopAll()

- stopAll() 应在 daemon shutdown 序列中有明确的最大等待时间
- 超过最大等待时间后，daemon 可以强制退出（接受少量孤儿进程的代价），不允许 daemon 因 stopAll() 永远不退出
- 推荐：总等待时间 = 每个 task 的 SIGTERM 等待时间 + SIGKILL 等待时间之和，受最大并发 task 数量约束

---

## 三、Reliability & Observability（可靠性与可观测性）

### 不可接受的失败

- SandboxLease 泄漏（任何退出路径下未调用 release()）：资源耗尽，不可接受
- subprocess 退出后未更新 TaskRecord.status：task 永久停留在 'running'，daemon 关闭时 stopAll() 会重复尝试 stop，不可接受
- workspace-rw task 未获取 SandboxLease 即写入 workspace：绕过安全边界，不可接受

### 可接受的失败

- OutputStore 写入失败（磁盘满、IO 错误）：subprocess 继续运行；部分 output 丢失；task 以最终状态完成
- async fn 未响应 abort signal：task 等待 fn 自然完成，不强制中止；status 在 fn 完成后正确更新
- 单个 task 的 stop() 超时后 SIGKILL：workspace 可能有未完成的文件写入；这是已知代价

### 可观测性

- TaskRecord 的状态变更应记录结构化日志（taskId、type、from_status、to_status、fileAccess）
- SandboxLease 的 acquire 和 release 应记录（taskId、sessionId、耗时）
- subprocess 退出时应记录 exit code 和 signal（便于区分正常退出、被 kill、异常退出）
- OutputStore 写入失败应记录（taskId、失败原因），便于分析磁盘或存储问题
- stopAll() 执行时应记录被停止的 task 数量和最终结果

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

### 当前不追求：output 完整性保证

OutputStore 写入失败时，output 可能部分丢失，task 不会因此中止。当前阶段不引入 output 的持久化重试机制或完整性校验（如行数 checksum）。output 的用途是调试和 agent 读取中间结果，不是关键数据，部分丢失可接受。

### 当前不追求：async fn 的强制中止

AsyncTaskRunner 通过 AbortController 发出 abort 信号，但无法强制终止不配合的 fn。强制中止 async fn 需要 Worker Thread 隔离，增加显著复杂度。当前阶段要求 fn 作者负责响应 signal，不引入 Worker Thread 机制。

### 当前不追求：workspace 写入的事务性保证

workspace-rw task 异常终止后，workspace 可能处于中间状态（部分文件写入）。当前不提供自动回滚或快照恢复机制。workspace 的一致性由调用方或更高层的 sandbox 策略负责，tasks 模块不感知 workspace 语义。

### 当前不追求：subprocess 的 CPU / 内存限制

当前不通过 cgroup 或 ulimit 对 subprocess 做资源配额限制。若单个 subprocess 消耗过多资源，会影响整个进程。资源配额控制属于运维和基础设施层，超出 tasks 模块职责范围，当前阶段暂缓。
