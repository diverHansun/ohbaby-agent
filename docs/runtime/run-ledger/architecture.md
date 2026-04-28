# run-ledger 模块 architecture.md

本文档描述 `runtime/run-ledger` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

run-ledger 是一个**薄持久化层**，内部结构极为扁平：一个公共接口类（RunLedger）直接操作 Drizzle ORM，没有中间层。

```
┌─────────────────────────────────────────────────────┐
│ RunLedger（公共接口）                                 │
│                                                     │
│ 职责：                                              │
│ - 接收 run-manager 的账本写入调用                    │
│ - 执行 run_ledger 表的 CRUD 操作                     │
│ - 提供诊断/恢复查询接口                              │
└─────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ services/database（Drizzle + SQLite）                │
│ run_ledger 表 Schema 由 database 模块统一管理         │
└─────────────────────────────────────────────────────┘
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **RunLedger** | 唯一公共类，封装所有账本读写操作 |

run-ledger 没有子组件。它不需要分层，因为它的全部职责就是"把 run-manager 的状态变更写进 DB，并在启动时提供恢复查询"。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Repository 模式（极简版）

RunLedger 是 `run_ledger` 表的 Repository，封装所有 SQL 操作，使 run-manager 不直接依赖 Drizzle 查询语法。

**使用理由**：
- run-manager 只需要语义化的方法名（`createPending`、`markRunning`、`markSucceeded`、`markCancelled`、`markInterrupted`），不需要知道 SQL 细节
- 未来如果 Schema 变更，只需修改 RunLedger 内部，不影响 run-manager

**不引入 Service 层的理由**：
- run-ledger 没有业务逻辑，只有数据操作；Service 层在这里是空壳，YAGNI

### 2. 未使用缓存层

run-ledger 不在内存中缓存账本状态。run-manager 的内存索引（`sessionId → active RunRecord[]`）是运行期控制权威，run-ledger 只是写目标和恢复来源，不需要自己维护内存副本。两层缓存会引入同步问题。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/run-ledger/
├── index.ts          # 公共接口：导出 RunLedger 类和 RunLedgerRecord 类型
├── ledger.ts         # RunLedger 类实现
├── types.ts          # RunStatus、RunLedgerRecord、TriggerSource 类型定义
└── __tests__/
    └── ledger.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 仅导出 RunLedger 和类型，不暴露内部实现 |
| `ledger.ts` | 核心实现 | 所有账本读写方法，依赖注入 Drizzle db 实例 |
| `types.ts` | 类型定义 | RunStatus、RunLedgerRecord；TriggerSource 若已在 ohbaby-sdk 定义则从 sdk 导入 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`RunLedger` 类的公共方法签名、`RunLedgerRecord` 类型
- **内部实现**：Drizzle 查询语句、SQL 条件构造

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. 不做热路径查询

`getActiveRuns()` 仅用于启动诊断和崩溃恢复，不用于运行期并发仲裁。这是有意的约束：让 run-ledger 保持"只写 + 冷读"的访问模式，避免它成为调度瓶颈。代价是 run-manager 必须自己维护内存索引，引入了双写复杂度，但这个复杂度由 run-manager 承担，run-ledger 保持简单。

### 2. 账本写入失败不阻塞 worker 结束

worker 完成后若 ledger end 写失败，内存状态仍推进，异步重试 ledger 更新。这是可用性优先于一致性的取舍：宁可账本短暂滞后，也不让 worker 因持久化失败而卡死。代价是极端情况下账本可能短暂显示 running 状态，但下次启动的 `markInterrupted` 会修正。

### 3. 放弃的方案：事件溯源（Event Sourcing）

可以把每次状态变更记录为独立事件行（`RunCreated`、`RunStarted`、`RunSucceeded`、`RunCancelled`），而不是直接 UPDATE 状态列。这样历史更完整，但对于 run-ledger 的核心用途（崩溃恢复 + 历史查询）来说过度复杂。当前的 UPDATE 模式已足够，且 `endedAt` / `startedAt` 字段已隐含了时间线信息。
