# tasks 模块 test.md

本文档说明如何验证 `runtime/tasks` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- TaskRecord 的状态机（pending → running → succeeded/failed/cancelled/timeout）
- fileAccess 策略对 SandboxLease 获取路径的控制
- ShellTaskRunner 的 subprocess 生命周期（启动、output 写入、正常退出、SIGTERM→SIGKILL）
- AsyncTaskRunner 的 fn 执行和 AbortController abort 路径
- stop() 的幂等性和终态检查
- stopAll() 正确遍历并停止所有 running task
- waitForLine() 阻塞直到满足 predicate 的 output 行出现

**不覆盖**：
- sandboxManager.acquire() 内部的 sandbox 分配逻辑（sandbox 模块侧）
- OutputStore 的文件系统写入实现（services/storage 侧）
- workspace 文件一致性保证（已知 tasks 模块不提供）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：fileAccess 与 SandboxLease

| 场景 | 预期结果 |
|------|---------|
| create({ fileAccess: 'none' }) | sandboxManager.acquire() 不被调用；subprocess 启动 |
| create({ fileAccess: 'workspace-ro' }) | sandboxManager.acquire(sessionId) 被调用；SandboxLease 持有到 task 结束 |
| create({ fileAccess: 'workspace-rw' }) | sandboxManager.acquire(sessionId) 被调用；SandboxLease 持有到 task 结束 |
| SandboxLease 获取失败 | task 不启动；TaskRecord.status = 'failed'；no lease held |

### 场景组 2：ShellTaskRunner 生命周期

| 场景 | 预期结果 |
|------|---------|
| subprocess 正常退出（exit code 0）| TaskRecord.status = 'succeeded'；SandboxLease.release() 被调用 |
| subprocess 以非 0 exit code 退出 | TaskRecord.status = 'failed'；SandboxLease.release() 被调用 |
| stop() 调用后 subprocess 响应 SIGTERM | TaskRecord.status = 'cancelled'；SandboxLease.release() 被调用 |
| stop() 调用后 subprocess 不响应 SIGTERM，超时 | 发送 SIGKILL；subprocess 终止；TaskRecord.status = 'cancelled' |
| subprocess 运行期间 OutputStore 写失败 | subprocess 继续运行；task 最终以实际 exit code 结束；部分 output 丢失 |

### 场景组 3：AsyncTaskRunner 生命周期

| 场景 | 预期结果 |
|------|---------|
| fn 正常完成（Promise resolve）| TaskRecord.status = 'succeeded'；SandboxLease.release() |
| fn 抛出异常（Promise reject）| TaskRecord.status = 'failed'；SandboxLease.release() |
| stop() 调用，fn 响应 signal.aborted | AbortController.abort() 触发；fn 提前退出；status = 'cancelled'；SandboxLease.release() |

### 场景组 4：stop() 幂等性与 stopAll()

| 场景 | 预期结果 |
|------|---------|
| stop() 已为终态的 task | 幂等，无操作 |
| stop() 不存在的 taskId | 幂等，返回（不报错）|
| stopAll()，有 3 个 running task | 3 个 task 均被 stop()；最终全部为 cancelled |

### 场景组 5：SandboxLease 泄漏验证

| 场景 | 预期结果 |
|------|---------|
| fn 抛出异常（async task，有 SandboxLease）| SandboxLease.release() 仍被调用（在 finally 路径）|
| SIGKILL 后 task 退出（shell task，有 SandboxLease）| SandboxLease.release() 仍被调用 |

---

## 三、Integration Points（集成点测试）

### 集成点 1：ShellTaskRunner + 真实 subprocess（集成测试）

**验证重点**：真实 subprocess 的启动、output 写入到 OutputStore、exit code 到 TaskRecord.status 的映射；SIGTERM → SIGKILL 路径

**方式**：使用真实 subprocess（如 `echo` / `sleep` 命令）；使用 tmp 目录作为 output 文件路径；不 mock subprocess 或 OutputStore

**关注**：
- output 行能被 readOutput() 正确读取
- SIGTERM 超时后 subprocess 确实被 SIGKILL（不再出现在 process 列表中）

### 集成点 2：AsyncTaskRunner + abort（集成测试）

**验证重点**：fn 正确感知 signal.aborted 并提前退出；SandboxLease 在 abort 路径下被释放

**方式**：真实 async fn（内部检查 signal.aborted，使用 delay + 轮询）；fake SandboxLease（记录 release() 调用）

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）+ subprocess 路径集成测试（integration）

**单元测试覆盖**：
- TaskManager 的路由逻辑（create → ShellTaskRunner 或 AsyncTaskRunner）
- fileAccess 策略对 SandboxLease 获取的控制（fake sandboxManager）
- TaskRecord 状态转换（不真实启动 subprocess/fn）
- stop() / stopAll() 的幂等性

**Mock 范围**（unit 层）：
- `sandboxManager` → fake SandboxManager（记录 acquire/release 调用；可配置失败）
- `OutputStore` → fake OutputStore
- `subprocess` → 不真实启动（用 fake Runner 模拟状态转换）
- `AbortController` → 真实对象（不 mock，它是纯逻辑）

**集成测试覆盖**（真实 subprocess）：
- ShellTaskRunner 的完整生命周期（真实 `echo`/`cat`/`sleep` 命令）
- SIGTERM → SIGKILL 超时路径（真实 subprocess 忽略 SIGTERM 的模拟命令）
- output 写入与 readOutput() 增量读取的一致性

### 关注点：SandboxLease 的释放路径

SandboxLease 泄漏测试必须覆盖所有退出路径：正常退出、failed、cancelled、SIGKILL、fn 异常。测试应断言 fake SandboxLease.release() 在每条路径下都被调用一次（不多不少）。

### 关注点：subprocess 的测试隔离

集成测试中的 subprocess 应使用短生命周期命令（`echo`、`sleep 0.1`），避免遗留孤儿进程。每个测试用例应验证 subprocess 在 task 结束后确实退出（通过 process.kill(pid, 0) 检查或 exit event）。
