# run-manager 模块 test.md

本文档说明如何验证 `runtime/run-manager` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- 并发仲裁：同 session 唯一活跃 Run 的不变量
- RunContext 组装：RunDefaultsPolicy 和 PermissionProfile 的正确加载
- RunWorker 生命周期：pre-run hook → markRunning → lifecycle → post-run hook → markSucceeded/Failed/Cancelled
- cancel() 路径：向 lifecycle 发送取消信号、最终 markCancelled
- 崩溃恢复：markInterrupted 的批量幂等性
- RunWorker panic 的隔离：不传播到 run-manager 主循环

**不覆盖**：
- lifecycle.run() 内部的 agent 主循环逻辑（lifecycle 侧的职责）
- hook 链内部的各内置 hook 行为（hooks 模块侧的职责）
- PermissionProfile 的查找逻辑（permission-profiles 模块侧的职责）
- run-ledger 的 DB 写入操作（run-ledger 侧的职责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：Run 创建的并发仲裁

| 场景 | 预期结果 |
|------|---------|
| session 无活跃 Run，create() | 创建成功，RunWorker 启动 |
| session 已有 status='pending' 或 status='running' Run，再次 create() | 返回 ConcurrencyConflict，不创建新 Run |
| 两个 create() 并发到达（同 session）| 只有一个成功，另一个返回 ConcurrencyConflict（不存在双 Run 同时创建的窗口）|
| session A 有活跃 Run，session B create() | 不受影响，正常创建（仲裁是 per-session 的）|

### 场景组 2：RunWorker 生命周期回调

| 场景 | 预期结果 |
|------|---------|
| lifecycle.run() 正常返回 | post-run hook 执行；markSucceeded；streamBridge.end() |
| lifecycle.run() 以 abort 退出 | post-run hook 执行；markCancelled；streamBridge.end() |
| lifecycle.run() 抛出异常 | post-run hook 执行；markFailed；streamBridge.end()；异常不传播到 run-manager |
| pre-run hook 失败（非 critical）| 记录日志；继续启动 lifecycle.run() |

### 场景组 3：cancel()

| 场景 | 预期结果 |
|------|---------|
| cancel() 正在运行的 Run | lifecycle 收到 abort 信号；Run 最终进入 cancelled 状态 |
| cancel() 已为终态的 Run | 幂等，无操作 |
| cancel() 不存在的 runId | 返回 NotFoundError |

### 场景组 4：崩溃恢复

| 场景 | 预期结果 |
|------|---------|
| DB 中有 status='running' 的 Run，initialize() | 全部标记为 interrupted |
| DB 中有 status='pending' 的 Run，initialize() | 全部标记为 interrupted |
| DB 中无 pending/running Run，initialize() | 无操作（幂等）|
| markInterrupted 执行后再次执行 | 不重复修改（已为 interrupted 的记录不受影响）|

---

## 三、Integration Points（集成点测试）

### 集成点 1：run-manager + run-ledger（集成测试）

**验证重点**：create() 触发 runLedger.createPending()；RunWorker 完成后触发 markSucceeded/Failed/Cancelled；markInterrupted 正确批量更新

**方式**：使用真实 in-memory SQLite（或临时文件 SQLite），不 mock run-ledger；断言 DB 中 RunRecord 状态的变更顺序和最终值

**关注**：RunRecord.status 在 lifecycle 完成后的正确更新（包括 failed 路径）

### 集成点 2：run-manager + hooks（集成测试或单元测试）

**验证重点**：RunWorker.start() 正确在 markRunning 之前调用 pre-run hook 链；在 lifecycle 完成后调用 post-run hook 链

**方式**：fake HookExecutor（记录调用顺序和传入的 ctx 字段）；断言 pre-run 先于 markRunning，post-run 后于 lifecycle.run() 返回

### 集成点 3：run-manager + streamBridge（单元测试）

**验证重点**：Run 完成后调用 streamBridge.end('run/<runId>')；scope 正确关闭

**方式**：fake StreamBridge

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）+ 关键路径集成测试（integration）

**单元测试覆盖**（mock 所有直接依赖）：
- 并发仲裁逻辑（ConcurrencyPolicy）
- RunContext 组装（RunDefaultsPolicy + PermissionProfile 的参数传递）
- cancel() 的幂等性和 NotFoundError 路径

**Mock 范围**（unit 层）：
- `runLedger` → fake RunLedger（记录调用，可配置失败）
- `lifecycle` → fake Lifecycle（记录 run() 调用，可配置 abort 或 throw）
- `hookExecutor` → fake HookExecutor（记录调用顺序）
- `streamBridge` → fake StreamBridge
- `permissionProfiles` → fake PermissionProfiles

**集成测试覆盖**（不 mock run-ledger）：
- 完整的 Run 生命周期（create → running → succeeded）验证 DB 状态变更
- markInterrupted 在 initialize() 时的批量更新
- RunWorker lifecycle.run() 抛出异常后 DB 状态的正确性

**不 mock**（integration 层）：run-ledger + 真实 SQLite（in-memory 或 tmp 文件）

### 关注点：并发仲裁的时序

并发仲裁测试必须覆盖真正的并发场景（两个 Promise 同时到达 create()），而不只是顺序调用。使用 `Promise.all([create(), create()])` 构造并发场景，断言只有一个成功。

### 关注点：RunWorker 异常隔离

lifecycle.run() 抛出异常的测试需要断言：run-manager 的 workers Map 中该 RunWorker 被移除；后续对同一 session 的 create() 能正常执行（run-manager 恢复可用状态）。
