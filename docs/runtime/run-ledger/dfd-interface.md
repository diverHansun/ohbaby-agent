# run-ledger 模块 dfd-interface.md

本文档描述 `runtime/run-ledger` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

run-ledger 是 runtime 的持久化账本层，是 run 状态的持久化权威（不参与热路径调度仲裁）。

| 方向 | 外部模块 | 交互方式 |
|---|---|---|
| 被调用 | `runtime/run-manager` | 写入账本状态变更（createPending / markRunning / markSucceeded / markFailed / markCancelled / markInterrupted）|
| 被调用 | `runtime/run-manager`（启动时）| 批量标记账本（markInterrupted，用于崩溃恢复）|
| 被调用 | CLI / 管理命令 | 读取历史 run 记录（list / getActiveRuns）|
| 依赖 | `services/database` | 通过 Drizzle 读写 `run_ledger` 表 |

**重要定位说明**：
- run-manager 的**内存索引**是运行期控制权威（热路径并发仲裁）
- run-ledger 是**持久化审计权威**（崩溃恢复 + 历史查询）
- run-ledger 不参与热路径，不提供并发仲裁服务

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Run 生命周期写入（正常路径）

```
run-manager.create()
  → runLedger.createPending({ runId, sessionId, triggerSource })
    [账本先行：内存索引更新之前写 DB]
  ↓
run-manager.startRun()（worker 开始执行后）
  → runLedger.markRunning(runId)
  ↓
worker 完成（正常）
  → runLedger.markSucceeded(runId)
  ↓
worker 完成（异常）
  → runLedger.markFailed(runId, error)
  ↓
worker 被主动取消
  → runLedger.markCancelled(runId, reason?)
```

### 流程 2：崩溃恢复读取（daemon 启动时）

```
daemon.init() → runManager.init()
  → runLedger.markInterrupted({ statuses: ['pending', 'running'] })
    [批量将遗留 run 标为 interrupted]
  ↓
内存索引为空（刚启动，无活跃 run）
  [遗留 run 在账本中标为 interrupted，不会被错误恢复执行]
```

### 流程 3：历史查询（诊断/UI）

```
CLI 或 Admin UI
  → runLedger.listBySession(sessionId, { limit?, cursor? })
    [按 session 分页查询历史 run 列表]
  → runLedger.get(runId)
    [查询单条 run 详情]
  ↓
返回 RunLedgerRecord[]（只含持久化字段，无内存对象）
```

**注意**：`getActiveRuns()` 仅用于启动诊断、管理命令和 debug UI，不用于运行期热路径仲裁。崩溃恢复本身不需要先查询再逐条更新。

---

## 三、Interface Definition（接口定义）

### 写入接口（由 run-manager 调用）

| 接口 | 语义 | 同步/异步 |
|---|---|---|
| `createPending(options)` | 创建状态为 'pending' 的账本记录 | 异步 |
| `markRunning(runId)` | 更新状态为 'running'，记录 startedAt | 异步 |
| `markSucceeded(runId)` | 更新状态为 'succeeded'，记录 endedAt | 异步 |
| `markFailed(runId, error)` | 更新状态为 'failed'，记录 error 和 endedAt | 异步 |
| `markCancelled(runId, reason?)` | 更新状态为 'cancelled'，记录 endedAt 和可选原因 | 异步 |
| `markInterrupted(options?)` | 将 running/pending run 标为 'interrupted'；默认批量处理 `statuses: ['pending', 'running']` | 异步 |

### 查询接口

| 接口 | 语义 | 使用场景 |
|---|---|---|
| `get(runId)` | 查询单条 RunLedgerRecord | 详情查看 |
| `listBySession(sessionId, options?)` | 分页查询 session 下的历史 run | 历史列表 |
| `getActiveRuns(sessionId?)` | 查询 status='running' 或 'pending' 的活跃账本记录 | 启动诊断 / 管理命令 / debug UI |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建 | 所有者 | 责任边界 |
|---|---|---|---|
| `run_ledger` 表记录 | run-ledger.createPending() | run-ledger（唯一写入方）| 状态变更全部由 run-manager 触发，run-ledger 执行写入 |
| `RunLedgerRecord` | run-ledger | run-ledger | 读取时返回 plain object，不含内存资源引用 |
| `RunStatus`（账本版）| run-ledger 写入 | run-ledger（持久化）| 与 run-manager 内存索引的状态保持最终一致（允许短暂滞后）|
| 账本写入失败处理 | run-manager 决策 | run-manager | ledger 写失败不阻塞 worker；run-manager 负责异步重试策略 |
