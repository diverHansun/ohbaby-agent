# run-manager 模块 dfd-interface.md

本文档描述 `runtime/run-manager` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

run-manager 是 runtime 控制面的核心，与以下模块发生直接数据交换：

| 方向 | 外部模块 | 交互类型 |
|---|---|---|
| 被调用 | heartbeat | Bus 事件触发 create()（间接，通过 WakeSignal）|
| 被调用 | CLI / TUI / API | 直接调用 create() / cancel() / get() / list() |
| 被调用 | daemon/supervisor | 调用 init()（崩溃恢复）/ cancelAll()（关闭） |
| 调用 | run-ledger | createPending / markRunning / markSucceeded / markFailed / markCancelled / markInterrupted |
| 调用 | stream-bridge | publish(run.* 事件) / end(scope) |
| 调用 | sandbox | acquire(sessionId) / release(lease) |
| 调用 | permission-profiles | getProfile(permissionProfileId) |
| 调用 | hooks | execute('pre-run', ctx) / execute('post-run', ctx) |
| 装配注入 | daemon/bootstrap | 注入 RunDefaultsPolicy |

**讨论范围**：本文档只描述 run-manager 的输入/输出数据流，不涉及 RunWorker 的内部执行细节（lifecycle 调用由 RunWorker 完成，不属于 run-manager 公共接口）。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Run 创建（create → startRun）

```
调用方传入 CreateRunOptions
  { sessionId, triggerSource, explicit?: { permissionProfileId?, multitaskStrategy?, disconnectMode? } }
  ↓
run-manager 从 RunDefaultsPolicy 中查找 triggerSource 对应的默认值
  ↓
merge RunDefaultsPolicy.defaults[triggerSource] + explicit 覆盖
  → 得到 resolvedProfileId, resolvedMultitaskStrategy, resolvedDisconnectMode
  ↓
读取内存索引 sessionId → activeRuns[]（热路径，不查 DB）
  → 若已有 active run 且 strategy='reject' → 抛出 ConcurrencyRejectedError
  → 若已有 active run 且 strategy='interrupt' → cancel 现有 run
  → 若 strategy='queue' → 加入等待队列
  ↓
runLedger.createPending({ runId, sessionId, triggerSource })  ← 账本先行
  ↓
写入内存索引：activeRuns[sessionId].push(runRecord)
  ↓
若可立即运行 → startRun(runRecord)
```

### 流程 2：Run 启动（startRun）

```
startRun(runRecord) 开始
  ↓
sandboxManager.acquire(sessionId) → SandboxLease
  ↓
profileRegistry.getProfile(resolvedProfileId) → PermissionProfile
  ↓
new AbortController()（保存在 RunRecord 中）
  ↓
构造 RunContext {
  runId, sessionId, sandboxLease, permissionProfile,
  abortSignal, triggerSource
}
  ↓
new RunWorker(context, { bus, bridge, hookExecutor, lifecycle })
  ↓
worker.start()
  → hookExecutor.execute('pre-run', ctx)
  → lifecycle.run(session, abortSignal)
  → hookExecutor.execute('post-run', ctx)
  ↓ [RunWorker 内部，整个执行期间]
RunWorker 订阅 Bus 事件 → 翻译为 run.{event} → streamBridge.publish(scope, event, data)
```

### 流程 3：Run 结束（worker 完成回调）

```
lifecycle.run() 返回（正常 / 异常 / abort）
  ↓
RunWorker 释放 Bus 订阅
  ↓
RunWorker 通知 RunManager：run 结束，exitStatus, error?
  ↓
RunManager 更新内存索引：从 activeRuns 移除
  ↓
sandboxManager.release(sandboxLease)
  ↓
runLedger.markSucceeded(runId) / markFailed(runId, error) / markCancelled(runId, reason)
  [若 ledger 写失败 → 异步重试，不阻塞 worker 结束]
  ↓
streamBridge.end(scope)  ← 发送 END_SENTINEL
```

### 流程 4：Run 取消（cancel）

```
cancel(runId) 调用
  ↓
RunManager 在内存索引中找到 RunRecord
  ↓
runRecord.abortController.abort()
  ↓
[RunWorker 感知到 abortSignal → lifecycle 停止 → worker 自然结束]
  ↓
走 流程 3 的结束路径（markCancelled）
```

### 流程 5：崩溃恢复（init）

```
daemon 启动时调用 runManager.init()
  ↓
runManager 调用 runLedger.markInterrupted({ statuses: ['pending', 'running'] })
  → 将 DB 中所有 status='running' 或 'pending' 的 run 标为 'interrupted'
  [这些 run 在上次进程退出前未正常结束]
  ↓
内存索引为空（进程刚启动，无活跃 run）
```

---

## 三、Interface Definition（接口定义）

### 接口 1：create(options)

**语义**：创建一次 Run，触发并发仲裁，成功后启动执行。

- **输入**：`sessionId`（会话 ID）、`triggerSource`（触发来源）、可选显式覆盖参数
- **输出**：`RunRecord`（已创建的运行记录）
- **同步/异步**：异步（等待 ledger 写入 + startRun 启动）
- **错误行为**：`ConcurrencyRejectedError` 若并发策略为 reject 且已有 active run

### 接口 2：cancel(runId)

**语义**：通过 AbortController 取消指定 run，不直接操作 worker。

- **输入**：`runId`
- **输出**：void（cancel 后 worker 自行清理）
- **同步/异步**：同步（仅触发 abort，不等待 worker 完成）

### 接口 3：get(runId) / list(sessionId)

**语义**：查询 RunRecord，读取内存索引，不查 DB。

- **get**：按 runId 返回 `RunRecord | undefined`
- **list**：按 sessionId 返回 `RunRecord[]`（仅 active runs）

### 接口 4：waitForCompletion(runId)

**语义**：等待指定 run 结束，返回最终状态。

- **输出**：`RunStatus`（'succeeded' | 'failed' | 'cancelled' | 'interrupted'）
- **同步/异步**：异步 Promise

### 接口 5：init()

**语义**：崩溃恢复，标记上次进程的遗留 run 为 interrupted。

- **调用时机**：daemon 启动时，在接受新请求前
- **同步/异步**：异步（写 DB）

### 接口 6：cancelAll()

**语义**：优雅关闭，取消所有 active runs。

- **调用时机**：daemon 收到 SIGTERM 时
- **同步/异步**：异步（等待所有 worker 结束）

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建者 | 所有者 | 责任边界 |
|---|---|---|---|
| RunRecord（内存） | RunManager.create() | RunManager | 热路径仲裁权威；run 结束后从内存移除 |
| RunRecord（DB） | runLedger.createPending() | run-ledger | 持久化审计/恢复权威；RunManager 触发写入 |
| AbortController | RunManager.startRun() | RunManager（存于 RunRecord）| RunWorker 只消费 abortSignal，不持有 controller |
| SandboxLease | sandboxManager.acquire() | RunManager（存于 RunRecord）| startRun 获取，run 结束时 release |
| RunContext | RunManager.startRun() 组装 | RunWorker | RunWorker 接收已解析的 context，不做依赖解析 |
| RunDefaultsPolicy | daemon/bootstrap 构建 | 装配层（注入到 RunManager）| RunManager 消费策略，不拥有触发源映射 |
| run.* 事件 | RunWorker 产生 | StreamBridge | RunWorker 翻译 Bus 事件后发布；bridge 管理 buffer |
| 账本 status | RunManager 触发 / run-ledger 写入 | run-ledger | RunManager 决定何时写，run-ledger 负责持久化 |
