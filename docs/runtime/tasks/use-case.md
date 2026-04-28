# tasks 模块 use-case.md

本文档描述 `runtime/tasks` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Create and Run a Shell Task | lifecycle / agent 工具 | 按 fileAccess 获取 SandboxLease，启动 subprocess，写 output |
| UC2 | Create and Run an Async Task | lifecycle / agent 工具 | 按 fileAccess 获取 SandboxLease，执行 fn，支持 abort |
| UC3 | Stop a Running Task | lifecycle / daemon | 优雅中止 subprocess 或 abort async fn |

---

## 二、Main Flow Description（主流程描述）

### UC1：Create and Run a Shell Task

shell task 的核心路径，fileAccess 决定是否需要 SandboxLease。

```
输入：taskManager.create({ type: 'shell', command, args?, sessionId, fileAccess })
  ↓
1. 分配 taskId，创建 TaskRecord { taskId, type: 'shell', status: 'pending', fileAccess }
  ↓
2. 路由到 ShellTaskRunner.start(record)
  ↓
3. SandboxLease 获取（按 fileAccess）：
   ├── fileAccess = 'workspace-ro' 或 'workspace-rw'
   │   → sandboxManager.acquire(sessionId) → SandboxLease
   │   → SandboxLease 限定 subprocess 的文件系统访问范围
   └── fileAccess = 'none'
       → 跳过 SandboxLease 获取（subprocess 无文件访问）
  ↓
4. TaskRecord.status → 'running'
  ↓
5. 启动 subprocess（在 SandboxLease 限定的环境中）
   → stdout/stderr 通过 OutputStore 写入 services/storage 文件（追加写）
  ↓
6. subprocess 结束（正常 / 失败 / 超时 / signal）
   → SandboxLease.release()（若已获取）
   → TaskRecord.status → 'succeeded' / 'failed' / 'cancelled' / 'timeout'
  ↓
输出：TaskRecord（调用方立即获得）；subprocess 在后台运行；output 持续写入
```

**关键约束**：`fileAccess: 'workspace-rw'` 必须显式声明；默认 `'none'`。不在运行时推断。

---

### UC2：Create and Run an Async Task

async task 的逻辑与 shell task 对称，SandboxLease 行为相同；差异在 fn 执行和 abort 机制。

```
输入：taskManager.create({ type: 'async', fn, sessionId, fileAccess })
  ↓
1. 分配 taskId，创建 TaskRecord { taskId, type: 'async', status: 'pending', fileAccess }
  ↓
2. 路由到 AsyncTaskRunner.start(record)
  ↓
3. SandboxLease 获取（逻辑与 UC1 完全相同）：
   ├── fileAccess = 'workspace-ro' / 'workspace-rw' → sandboxManager.acquire(sessionId)
   └── fileAccess = 'none' → 跳过
  ↓
4. TaskRecord.status → 'running'
  ↓
5. AsyncTaskRunner 创建 AbortController
   → 调用 fn(abortController.signal)
   → fn 在 AbortController 信号控制下执行
  ↓
6. Promise 完成 / 被 abort
   → SandboxLease.release()（若已获取）
   → TaskRecord.status → 'succeeded' / 'failed' / 'cancelled'
  ↓
输出：TaskRecord（调用方立即获得）；fn 在后台执行
```

---

### UC3：Stop a Running Task

优雅中止路径，两类 task 的中止机制不同。

```
输入：taskManager.stop(taskId)
  ↓
1. 查找 TaskRecord
   → 若未找到或已为终态（succeeded/failed/cancelled/timeout） → 返回（幂等）
  ↓
2. 路由到对应 Runner.stop()：

  [ShellTaskRunner]
    → 发送 SIGTERM 给 subprocess
    → 等待 subprocess 退出（有限时间）
    → 超时仍未退出 → 发送 SIGKILL（强制终止）
    → TaskRecord.status → 'cancelled'

  [AsyncTaskRunner]
    → AbortController.abort()
    → fn 内部通过 signal 感知中止，自行清理
    → Promise 完成 → TaskRecord.status → 'cancelled'
  ↓
3. SandboxLease.release()（若未在 task 完成时释放）
  ↓
输出：task 进入 cancelled 状态；资源释放
```

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| fileAccess 策略确定 | 调用方（创建时传入）| TaskManager 不推断；显式声明是合约 |
| SandboxLease 获取与释放 | 对应 TaskRunner（持有期间）| TaskManager 不直接持有 lease；lease 跟随 task 生命周期 |
| subprocess 启动与管理 | ShellTaskRunner（内部）| TaskManager 不直接操作进程句柄 |
| output 写入 | OutputStore（TaskRunner 调用）| 写入路径由 OutputStore 管理；TaskManager 不处理文件 |
| AbortController 生命周期 | AsyncTaskRunner（内部）| stop() 触发 abort；fn 负责响应 signal |
| 输出读取（readOutput / waitForLine）| TaskManager 代理 OutputStore | TaskManager 是查询入口；存储由 services/storage 负责 |
| stopAll() | TaskManager | daemon 关闭时调用；TaskManager 遍历所有 running task 逐一 stop |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：SandboxLease 获取失败

**场景**：sandboxManager.acquire() 失败（沙箱资源不足或初始化失败）
**预期行为**：task 不启动；TaskRecord.status → 'failed'；SandboxLease 不持有
**注意**：调用方需处理 create() 返回的 failed TaskRecord，不应假定 task 一定启动成功

### 决策点 2：SIGTERM 后 subprocess 不退出

**场景**：subprocess 忽略 SIGTERM（如捕获了 SIGTERM 信号但不退出）
**当前策略**：等待固定时间（具体超时值在实现阶段确定）后发送 SIGKILL 强制终止
**风险**：SIGKILL 会立即终止进程，workspace 中可能有未完成的文件写入；workspace-rw task 尤其需要注意

### 失败点 1：OutputStore 写入失败

**场景**：subprocess 运行中 services/storage 写入失败（磁盘满、IO 错误）
**预期行为**：OutputStore 记录错误；subprocess 继续运行（不因 output 写入失败而中止）；部分输出丢失
**注意**：当前不提供 output 完整性保证；这是一个已知的约束

### 失败点 2：async fn 未响应 abort signal

**场景**：fn 未检查 abortSignal，AbortController.abort() 后 fn 继续运行
**预期行为**：AsyncTaskRunner 无法强制中止 Promise；task 只能等待 fn 自然完成后才更新状态
**注意**：fn 作者有责任在长时操作中检查 signal.aborted；TaskManager 不强制执行

### 失败点 3：workspace-rw task 异常终止后的文件状态

**场景**：subprocess/fn 在写入 workspace 中途被 SIGKILL 或 panic 中止
**预期行为**：SandboxLease.release() 在 task 退出后执行（即使异常）；workspace 文件状态不由 tasks 模块保证
**注意**：workspace 的一致性恢复不在 tasks 职责范围；由 sandbox 模块或调用方处理
