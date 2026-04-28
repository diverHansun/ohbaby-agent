# run-ledger 模块 data-model.md

本文档定义 `runtime/run-ledger` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### 概念 1：RunLedgerRecord（账本记录）

一次 Run 的持久化快照，是 RunRecord 的可序列化子集。RunLedgerRecord 只包含可写入 DB 的字段，不含内存资源（AbortController、SandboxLease）。

run-ledger 的全部职责就是对这个类型进行 CRUD。

### 概念 2：RunStatus（账本视角的 Run 状态）

run-ledger 维护的 Run 状态枚举。注意：账本状态与 run-manager 内存状态最终一致，但允许短暂滞后（账本写失败时异步重试）。

账本状态是历史审计和崩溃恢复的依据，不是热路径并发仲裁的依据。

---

## 二、Key Data Fields（关键数据字段）

### RunLedgerRecord 字段说明

| 字段 | 含义 |
|---|---|
| `runId` | Run 唯一标识，与 run-manager 的 RunRecord.runId 相同 |
| `sessionId` | 所属 session，用于按 session 查询历史 run |
| `triggerSource` | 触发来源（`'user' \| 'scheduler' \| 'heartbeat' \| 'channel' \| 'follow-up'`），供审计使用；scheduler 内部的 `scheduled/reminder` 是 job kind，不直接作为 Run 的 triggerSource |
| `status` | 账本状态（见下方说明）|
| `createdAt` | Run 创建时间戳 |
| `startedAt` | Run 实际开始执行时间戳（`markRunning` 时写入）|
| `endedAt` | Run 结束时间戳（`markSucceeded / markFailed / markCancelled / markInterrupted` 时写入）|
| `error` | 失败或中断原因描述（status = `failed/cancelled/interrupted` 时可能有值）|

### RunStatus 枚举说明

| 状态 | 写入时机 | 说明 |
|---|---|---|
| `pending` | `createPending()` | Run 已创建，尚未开始执行 |
| `running` | `markRunning()` | Run 已开始执行 |
| `succeeded` | `markSucceeded()` | 正常结束 |
| `failed` | `markFailed()` | 异常退出 |
| `cancelled` | `markCancelled()` | 用户或系统主动取消 |
| `interrupted` | `markInterrupted()` | 进程崩溃导致未正常关闭 |

**崩溃恢复依据**：daemon 重启时，`status = 'running'` 或 `'pending'` 的记录被视为崩溃遗留，批量标为 `'interrupted'`。

---

## 三、Lifecycle & Ownership（生命周期与归属）

### RunLedgerRecord 生命周期

```
run-manager.create() 调用
  → run-ledger.createPending()  ← status: 'pending' 写入 DB

run 开始执行
  → run-ledger.markRunning()  ← status: 'running', startedAt

run 正常结束
  → run-ledger.markSucceeded()  ← status: 'succeeded', endedAt

run 异常结束
  → run-ledger.markFailed()  ← status: 'failed', endedAt, error

run 被主动取消
  → run-ledger.markCancelled()  ← status: 'cancelled', endedAt, error?

run 被异常中断（进程崩溃恢复）
  → run-ledger.markInterrupted()  ← status: 'interrupted', endedAt

[记录永久保留，供历史查询和审计]
```

### 数据归属说明

- RunLedgerRecord 由 run-ledger 创建和持久化，是唯一写入方
- run-manager 是写入的触发方（决定何时调用账本方法）
- 账本记录永久保留，不会被自动删除（清理策略未定义，属于未来需求）
- 账本记录是持久化审计权威；run-manager 内存索引是热路径控制权威

---

## 四、文档自检

- [x] RunLedgerRecord 作为 RunRecord 可序列化子集的定位清晰
- [x] 账本状态与内存状态"最终一致"的约束说明
- [x] `interrupted` 状态作为崩溃恢复机制的用途明确
- [x] 账本不参与热路径的边界说明
