# run-manager 模块 use-case.md

本文档描述 `runtime/run-manager` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Create and Start a Run | heartbeat / user（CLI/API）| 并发仲裁、RunContext 组装、生命周期启动 |
| UC2 | Cancel an Active Run | user 指令（CLI/API）| 中止运行中的 Run，更新状态 |
| UC3 | Recover from Process Crash | daemon 启动时 | 标记中断 Run，恢复可用状态 |

---

## 二、Main Flow Description（主流程描述）

### UC1：Create and Start a Run

run-manager 的核心路径，由 heartbeat（自动触发）或 user（手动触发）发起。

```
输入：create({ triggerSource, sessionId? })
  ↓
1. 并发仲裁（ConcurrencyPolicy）
   → 检查该 session 是否已有 status='pending' 或 status='running' 的 active Run
     ├── 已有 → 拒绝创建，返回 ConcurrencyConflict
     └── 无   → 继续
  ↓
2. 组装 RunContext
   → 从 RunDefaultsPolicy 获取 triggerSource 对应的默认配置
   → 加载 PermissionProfile（通过 permissionProfiles 模块）
   → 构建 RunContext { runId, sessionId, triggerSource, permissionProfile, ... }
  ↓
3. 持久化 RunRecord
   → runLedger.createPending({ runId, sessionId, triggerSource })
  ↓
4. 启动 RunWorker
   → new RunWorker(context, lifecycle, hooks, streamBridge)
   → runWorker.start()
     → hookExecutor.execute('pre-run', ctx)（等待 hook 链完成）
     → runLedger.markRunning(runId)（更新 status → 'running'）
     → lifecycle.run(ctx)（移交给 lifecycle，进入 agent 主循环）
  ↓
5. RunWorker 注册完成回调
   → lifecycle.run() 返回（正常 / abort）后：
     → hookExecutor.execute('post-run', ctx)
     → 根据结果调用 runLedger.markSucceeded / markFailed / markCancelled
     → streamBridge.end('run/<runId>')
  ↓
输出：RunRecord（含 runId）；Run 在后台异步执行
```

**注意**：create() 是异步的，RunWorker.start() 启动后立即返回；调用方不等待 Run 完成。

---

### UC2：Cancel an Active Run

用户主动中止一个正在运行的 Run。

```
输入：cancel(runId)
  ↓
1. 查找 RunWorker（内存索引）
   → workers.get(runId)
     ├── 未找到 → 返回 NotFoundError
     └── 找到   → 继续
  ↓
2. 检查 Run 状态
   → 若 status 已为终态（succeeded/failed/cancelled） → 返回（幂等）
  ↓
3. 触发中止
   → runWorker.cancel()
     → 向 lifecycle 发送取消信号（AbortController.abort()）
     → lifecycle 进入中止路径（agent 主循环退出）
  ↓
4. 等待 RunWorker 完成退出
   → lifecycle.run() 以 abort 退出
   → RunWorker 的完成回调执行：
     → hookExecutor.execute('post-run', { result: 'cancelled', ... })
     → runLedger.markCancelled(runId)
     → streamBridge.end('run/<runId>')
  ↓
输出：Run 进入 cancelled 状态；资源释放；stream 关闭
```

---

### UC3：Recover from Process Crash

daemon 启动时检测上次进程崩溃遗留的 interrupted Run，将其标记为已中断。

```
触发时机：daemon 启动阶段，在 RunWorker 开始处理新请求之前
  ↓
1. run-manager.initialize() 调用
  ↓
2. 批量标记中断
   → runLedger.markInterrupted({ statuses: ['pending', 'running'] })
   → 将所有 status 为 'pending' 或 'running' 的 RunRecord 批量更新为 'interrupted'
  ↓
3. 清理内存状态
   → 确认内存中 workers Map 为空（进程重启后自然清空）
  ↓
输出：所有遗留的 pending/running Run 被标记为 interrupted；
      run-manager 处于干净初始状态，可以接受新的创建请求
```

**注意**：崩溃恢复不重新执行被中断的 Run；是否续跑由 heartbeat 的 scheduler/follow-up 策略决定，不由 run-manager 自行发起。

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| 并发仲裁（同 session 唯一活跃 Run）| run-manager（ConcurrencyPolicy）| heartbeat 不参与这一决策；run-manager 是唯一仲裁者 |
| RunContext 组装 | run-manager | 从 RunDefaultsPolicy + PermissionProfile 构建，lifecycle 只消费 |
| RunRecord 持久化 | runLedger（被调用）| run-manager 决定写入时机，runLedger 负责 DB 操作 |
| lifecycle.run() 执行 | lifecycle（被调用）| run-manager 启动和等待；agent 主循环内部逻辑不属于 run-manager |
| hook 链调用 | hookExecutor（被调用）| run-manager 决定何时 execute，hookExecutor 负责串行执行 |
| stream scope 的开启/关闭 | run-manager（via RunWorker）| streamBridge.end() 由 RunWorker 完成回调中调用 |
| 取消信号传递 | run-manager → lifecycle（AbortController）| run-manager 发出取消，lifecycle 负责响应 |
| 崩溃恢复决策 | run-manager | 仅在 initialize() 阶段执行一次批量 markInterrupted |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：并发冲突处理策略

**问题**：heartbeat 发来 create 请求时，同 session 已有 pending / running Run
**当前策略**：拒绝创建，返回 ConcurrencyConflict（不排队）
**理由**：避免信号堆积导致多 Run 串行执行；heartbeat 的 DeferredQueue 负责信号缓冲，run-manager 不二次缓冲

### 决策点 2：pre-run hook 失败的处理

**问题**：hookExecutor.execute('pre-run') 中某个 hook 抛出异常
**当前策略**：非 critical hook 失败记录日志继续；critical hook（MVP 未实现）失败中断启动
**影响**：当前阶段所有 hook 均为非 critical，pre-run 失败不阻断 Run 启动

### 失败点 1：runLedger.createPending() 失败

**场景**：DB 写入失败，无法持久化 RunRecord
**预期行为**：不启动 RunWorker；run-manager 返回错误；Run 未创建
**注意**：此时没有需要清理的资源（RunWorker 未启动）

### 失败点 2：RunWorker 内部 panic / 未捕获异常

**场景**：lifecycle.run() 抛出未捕获异常
**预期行为**：RunWorker 的完成回调以 'failed' 结果执行；runLedger.markFailed(runId)；stream 关闭
**注意**：run-manager 不应因单个 RunWorker 的崩溃影响其他 Run 的创建能力

### 失败点 3：daemon 重启时崩溃恢复窗口

**场景**：进程在 markInterrupted 执行过程中再次崩溃
**预期行为**：下次启动时重新执行 markInterrupted；markInterrupted 是幂等操作（重复执行无副作用）
