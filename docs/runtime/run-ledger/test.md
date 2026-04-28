# run-ledger 模块 test.md

本文档说明如何验证 `runtime/run-ledger` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- RunLedgerRecord 的 CRUD：create、markRunning、markSucceeded、markFailed、markCancelled、markInterrupted
- 状态转换的合法性：只允许从当前状态到指定下一状态（如不允许 succeeded → running）
- markInterrupted 的批量幂等性（statuses 参数过滤）
- getActiveRuns() 和 getHistory() 的查询正确性
- DB 写入顺序：create 必须在 markRunning 之前

**不覆盖**：
- run-manager 调用 run-ledger 的时机（run-manager 侧的职责）
- SQLite WAL 模式、事务隔离级别（services/database 层的约定）
- schema 迁移脚本（smoke 层的职责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：生命周期写入序列

| 场景 | 预期结果 |
|------|---------|
| create(runId, sessionId, triggerSource) | 插入 status='pending' 记录 |
| markRunning(runId) | status → 'running'；started_at 记录 |
| markSucceeded(runId) | status → 'succeeded'；ended_at 记录 |
| markFailed(runId) | status → 'failed'；ended_at 记录 |
| markCancelled(runId) | status → 'cancelled'；ended_at 记录 |
| markInterrupted({ statuses: ['pending', 'running'] }) | 所有 status 为 pending/running 的记录 → interrupted；其余不变 |

### 场景组 2：非法状态转换

| 场景 | 预期结果 |
|------|---------|
| 对 status='succeeded' 的 Run 调用 markRunning | 抛出异常或返回错误；DB 不修改 |
| 对不存在的 runId 调用 markSucceeded | 抛出 NotFoundError |

### 场景组 3：查询

| 场景 | 预期结果 |
|------|---------|
| getActiveRuns()，DB 有 2 pending + 1 running | 返回 3 条记录 |
| getActiveRuns()，DB 无 active Run | 返回空数组 |
| getHistory(sessionId, { limit: 5 }) | 返回该 session 最新的 5 条记录，按 created_at 倒序 |

### 场景组 4：markInterrupted 的批量幂等性

| 场景 | 预期结果 |
|------|---------|
| markInterrupted 重复调用两次 | 第二次无副作用（已为 interrupted 的记录不重复修改）|
| DB 中有 succeeded Run，markInterrupted({ statuses: ['pending','running'] }) | succeeded Run 不受影响 |

---

## 三、Integration Points（集成点测试）

run-ledger 是薄持久化层，其价值就是 DB 行为。所有测试均使用真实 SQLite，不 mock DB。

**测试数据库选择**：
- 优先使用 in-memory SQLite（`:memory:`）：速度快，每个测试用例独立 schema
- 若 in-memory 不支持某些 WAL 特性，改用 tmp 文件 SQLite（测试结束后清理）

**不应 mock**：SchedulerStore / RunLedger 的 DB 操作——mock 掉 DB 等于没有测试

---

## 四、Verification Strategy（验证策略）

### 主策略：集成测试（integration），以真实 SQLite 为核心

**测试对象**：RunLedger 的所有公共方法

**数据库 Fixture**：每个测试用例在 setup 时创建 schema（CREATE TABLE）并 teardown 时销毁（in-memory DB 自动销毁，tmp file 需手动删除）

**断言方式**：
- 调用 RunLedger 方法后，直接查询 DB 断言 RunLedgerRecord 字段
- 不依赖 RunLedger 的读取方法来验证写入结果（避免读写同一接口掩盖 bug）；直接 `SELECT` 语句验证

**Fixture 设计**：
```
// 每个测试组共享的 factory
makeRunRecord({ runId = 'test-run-1', sessionId = 'sess-1', triggerSource = 'user' })
```

### 关注点：非法状态转换的错误行为

run-ledger 的状态转换保护是防止数据损坏的最后一道防线。测试必须验证：当 run-manager 传入非法序列时，run-ledger 拒绝写入（抛出异常），而不是静默接受。这个测试与 run-manager 的单元测试互补，共同保证协议的端到端正确性。
