# 02 实施方案（彻底修复）

> 文档职责：给出彻底修复方案、改动清单（精确到文件）、数据库迁移、向后兼容、风险与提交批次。前置：[`01-root-cause-analysis.md`](./01-root-cause-analysis.md)。
> 修复路线：方案 B（彻底修）。不只是在 in-process 路径关闭 lease，而是把"运行所有权 + 崩溃恢复"职责从 `ui-persistent` 的全局 lease 重定位到 `run-ledger`，用 per-run owner 记录承载。

---

## 一、设计原则与目标不变量

- 并发控制只由 per-session `claimPendingRun` 负责：同一 session 不并发；不同 session 可并发。
- 崩溃恢复改为 per-run 所有权判定：只恢复"owner 进程已死"的孤儿 run，绝不阻塞存活 owner 的 run。
- 移除全局 backend lease（单行锁 + 全局计数 + 提交前闸门），消除跨窗口/跨 session 的全局串行。
- 职责归位：run 的 owner 与恢复属于 `run-ledger`（运行生命周期归属者），不属于 UI 适配器。

目标不变量（一句话）：一个 run 的写入权属于创建它的进程（owner）；该 run 的 session 在它结束前不接受同 session 的新 run；当 owner 进程消失，其孤儿 run 可被任意进程安全回收。

---

## 二、改动清单

### 改动 1：数据库迁移（新增 migration 006）

文件：[services/database/migrations.ts](../../../packages/ohbaby-agent/src/services/database/migrations.ts)

- 为 `run_ledger` 增加所有权列：
  - `owner_id TEXT`：创建该 run 的 backend owner 标识（复用现有 `createBackendOwnerId` 的取值方式）。
  - `owner_pid INTEGER`：创建该 run 的进程 PID，用于存活判定。
- 清理历史全局 lease 行：`DELETE FROM app_state WHERE scope = 'global' AND key = 'persistentUiBackendLease'`。
- 既有行的 owner 列为 NULL（旧数据/升级前的 run）。NULL owner 视为"无法验证归属" -> 启动恢复时按孤儿处理（安全：这些 run 不可能仍在运行）。

迁移机制为版本化顺序 SQL（[services/database/index.ts](../../../packages/ohbaby-agent/src/services/database/index.ts) 的 runMigrations），追加一个新版本即可，不改既有版本。SQLite 的 `ALTER TABLE ADD COLUMN` 与现有 005 迁移用法一致。

### 改动 2：schema 映射

文件：[services/database/schema.ts](../../../packages/ohbaby-agent/src/services/database/schema.ts)

- `runLedger` 增加 `ownerId: "owner_id"`、`ownerPid: "owner_pid"`。

### 改动 3：run-ledger 承载所有权与恢复（核心）

文件：[runtime/run-ledger/types.ts](../../../packages/ohbaby-agent/src/runtime/run-ledger/types.ts)、[runtime/run-ledger/database.ts](../../../packages/ohbaby-agent/src/runtime/run-ledger/database.ts)、[runtime/run-ledger/in-memory.ts](../../../packages/ohbaby-agent/src/runtime/run-ledger/in-memory.ts)

- 输入扩展：`CreatePendingRunLedgerInput` / `ClaimPendingRunLedgerInput` 增加 `ownerId`、`ownerPid`。
- 记录扩展：`RunLedgerRecord` 增加可选 `ownerId`、`ownerPid`。
- 注入存活判定：`createDatabaseRunLedger` / in-memory 工厂接受可选 `isOwnerAlive: (pid: number) => boolean`（默认实现为基于 `process.kill(pid, 0)` 的存活探测，即把现有 `isProcessAlive` 迁移到 run-ledger 或共享 util）。注入是为了测试可控。
- `claimPendingRun` 改为所有权感知（在同一 IMMEDIATE 事务内）：
  1. 查该 session 的 active runs。
  2. 若全部 active run 的 owner 进程均已死（或 owner 为 NULL）-> 将它们标 interrupted（懒恢复），然后插入新 pending。
  3. 若存在任一 active run 的 owner 仍存活 -> 抛 `SessionRunBusyError`（真实的同 session 并发，正确拒绝）。
- 新增 `recoverOrphanedRuns(): Promise<MarkInterruptedResult>`：全表扫描 `status IN ('pending','running')`，把 owner 已死/为 NULL 的 run 标 interrupted（启动时调用）。该操作只触碰死 owner 的 run，因此全局执行是安全的。
- `insertPendingRow` 写入 owner_id/owner_pid。

设计说明：把懒恢复放进 `claimPendingRun` 是为了让 per-session 闸门成为并发与恢复的唯一真相点——某 session 若卡着一个死 owner 的 running 行（窗口崩溃留下），重开该 session 再提交不会被永久拒绝。

### 改动 4：ui-persistent 移除全局 lease

文件：[adapters/ui-persistent.ts](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts)

- 删除：`BackendLease` 相关常量与类型、`readBackendLease`/`writeBackendLease`、`countActiveRuns`/`listActiveRunIds`、`refreshBackendLeaseIfSafe`/`inspectBackendLeaseForRecovery`/`releaseBackendLeasePreparation`、`shouldRecoverStartupRuns`、`createInProcess...` 中的 `beforePromptSubmit`/`afterPromptSubmitSettled` 全局闸门、`backendLeaseMode` 选项与 `backendLeaseEnabled`。
- 替换启动恢复：用 `runLedger.recoverOrphanedRuns()` 替代原 `shouldRecoverStartupRuns + markInterrupted({pending,running})` 的全局逻辑。
- 传入所有权：构造 run-ledger 时提供 `ownerId`（`createBackendOwnerId()`）、`ownerPid`（`process.pid`）与 `isOwnerAlive`，并在创建 pending/claim 时带上 owner。
- `isProcessAlive` / `createBackendOwnerId` 迁移到 run-ledger 或共享 util（归属随职责走）。

### 改动 5：ohbaby-server 停止传 backendLeaseMode

文件：[ohbaby-server/src/runtime/daemon/main.ts:92](../../../packages/ohbaby-server/src/runtime/daemon/main.ts#L92)

- 移除 `backendLeaseMode: "disabled"`（该选项已删除）。server 的单写者由其自身 prompt-queue 协调保证，无行为变化。

---

## 三、待确认的设计决策

| 决策点 | 选项 A | 选项 B | 倾向 |
|--------|--------|--------|------|
| 存活判定信号 | 仅按 PID 存活（`process.kill(pid,0)`） | PID 存活 + 心跳/超时 | A 为主：本机 coding CLI 单机场景，PID 探测足够；超时需运行期心跳写入，较侵入。把超时列为后续硬化项（应对 PID 复用的极端边界）。 |
| 恢复触发点 | 仅启动时 `recoverOrphanedRuns` | 启动时 + `claimPendingRun` 内懒恢复 | B：启动清全局孤儿，claim 内兜住"重开崩溃 session"的场景，二者都需要。 |
| owner 列粒度 | run_ledger 加列 | 单独 run_owner 表 | 加列：owner 是 run 的内在属性，cohesion 更好，避免多表 join。 |

PID 复用风险说明：理论上一个已死进程的 PID 可能被新进程复用，导致"死 owner"被误判为存活。本机短生命周期窗口场景概率极低；如需消除，可在 owner_id 之外加入进程启动时间戳或心跳，作为后续硬化（不在本次范围）。

---

## 四、向后兼容与迁移

- 升级即生效：migration 006 自动执行，旧 run 行 owner 为 NULL，启动 `recoverOrphanedRuns` 会把 NULL-owner 的 active 行标 interrupted（它们不可能仍在运行）。
- 历史 lease 行被 006 清理，不残留。
- 无需用户手动迁移；无需删库。
- 行为变化（需写入 changelog）：同机多窗口现在可并发运行（不同 session）；这正是修复目标，但对依赖"全局串行"隐式行为的脚本是可感知变化。

---

## 五、提交批次（建议）

1. migration 006 + schema 映射（仅加列与清理，独立可测）。
2. run-ledger owner 字段 + `isOwnerAlive` 注入 + `recoverOrphanedRuns` + claim 所有权感知（含单元测试）。
3. ui-persistent 移除全局 lease + 接线 owner/恢复。
4. ohbaby-server 去掉 backendLeaseMode。
5. 文档与 changelog。

每批跑全量门；先写失败回归测试（见 03）再改实现（TDD）。

---

## 六、风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 删除 lease 影响 server | server 也用过 `backendLeaseMode: "disabled"` | server 靠自身 prompt-queue 协调，移除选项无行为变化；集成测试覆盖 |
| 懒恢复误删存活 run | claim 内若误判 owner 死亡会回收他人 run | 存活判定保守（探测失败时视为存活更安全的策略需在实现中明确）；单元测试覆盖 alive/dead 两路 |
| PID 复用误判 | 死 PID 被复用 | 本机概率极低；列为后续硬化（心跳/启动时间戳） |
| 迁移在已有库上失败 | ALTER 与既有数据 | 与 005 迁移同模式；集成测试用真实库验证升级路径 |
| 全局恢复触碰他人 active 行 | 启动恢复扫全表 | 只标记 owner 已死/NULL 的行，存活 owner 的行不动 |

---

## 七、与既有设计文档的关系

本修复发生在 `ohbaby-agent`（run-ledger + ui-persistent 适配器）与少量 `ohbaby-server` 接线，不改变 ohbaby-server 模块设计（`docs/ohbaby-server/`）的边界结论。它纠正的是迁移遗留的实现耦合，与"显式 server 的多客户端协调（prompt-queue/permission/replay）"是不同层面：那是 server 模式的协调，本修复是默认 in-process 的并发与恢复。
