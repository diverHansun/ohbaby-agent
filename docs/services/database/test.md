# database 模块 test.md

本文档定义 `services/database` 模块的测试范围、关键场景与验证策略。目标是建立对"数据库基础设施行为正确"的信心，而不是追求覆盖率数字。

---

## 一、Test Scope（测试范围）

### 覆盖的职责

| 职责 | 测试重点 |
|------|----------|
| D1: 连接初始化与 pragma 配置 | WAL/FK/busy_timeout 是否在连接后实际生效 |
| D3: 迁移执行 | pending 判断、事务回滚、阻止启动、幂等性 |
| D4: 事务支持 | 失败自动回滚、成功提交 |
| D5: Busy Retry | SQLITE_BUSY 触发重试、重试耗尽抛出错误 |
| D6: 数据库文件路径管理 | 默认 XDG 路径、环境变量覆盖 |

### 不在本模块测试范围内

- `session` / `message` / `run_ledger` 等业务表的查询逻辑（由各业务模块测试）
- schema 字段的业务含义（由业务模块验证）
- services/storage 的文件操作（独立模块）
- Drizzle ORM 框架本身的正确性（框架级别，无需覆盖）
- WAL 在不同操作系统下的文件行为（属于 smoke test，在 CI 环境执行一次即可）

---

## 二、Critical Scenarios（关键场景）

### S1: pragma 在连接后实际生效

**前置**：调用 `initDatabase()`，使用临时文件数据库。不要用 `:memory:` 验证 WAL，因为 SQLite 内存库不支持 WAL journal mode。

**验证**：
- `PRAGMA journal_mode` 返回 `wal`
- `PRAGMA foreign_keys` 返回 `1`
- `PRAGMA busy_timeout` 返回 `5000`

**为什么关键**：pragma 不生效时，WAL 优势消失，外键约束形同虚设，可能导致数据不一致。

---

### S2: 首次初始化执行全部迁移

**前置**：空数据库，`migrations/` 目录中有 3 条迁移文件

**验证**：
- 3 条迁移均被执行
- `migration` 表有 3 行记录，`version` 字段正确
- 迁移所建的表均已存在

**为什么关键**：迁移是 schema 的唯一来源，首次初始化必须完整执行。

---

### S3: 重复初始化不重复执行迁移（幂等性）

**前置**：已初始化的数据库（3 条迁移），再次调用 `initDatabase()`

**验证**：
- `migration` 表仍只有 3 行，无重复记录
- 不抛出错误

**为什么关键**：daemon 重启场景的基本保障，幂等性失败会导致迁移重复执行。

---

### S4: 迁移失败回滚并阻止启动

**前置**：`migrations/002_bad.sql` 包含语法错误 SQL

**验证**：
- 抛出 `MigrationError`，错误信息包含失败的版本号（`002`）
- `migration` 表只有 `001` 的记录（`002` 已回滚）
- `002` 迁移引入的表或列不存在

**为什么关键**：部分执行的迁移会导致 schema 与代码不一致，必须全事务回滚并阻止启动。

---

### S5: 外键约束违反被 DB 层拦截

**前置**：初始化包含 `message` 和 `session` 表的数据库（带外键约束）

**操作**：向 `message` 表插入一行，`session_id` 引用不存在的 session

**验证**：抛出 SQLite foreign key constraint 错误

**为什么关键**：G5 要求 FK 约束在 DB 层生效，不依赖应用层检查。如果 `PRAGMA foreign_keys = ON` 未生效，此测试会暴露问题。

---

### S6: withTransaction 失败时自动回滚

**前置**：初始化包含 `session` 表和 `message` 表的数据库

**操作**：
```
withTransaction(fn):
  fn 中：先插入一条合法的 session 行（A）
         再插入一条违反外键的 message 行（B，引用不存在 session_id）
```

**验证**：
- 整体抛出约束错误
- `session` 表中无 A 行（A 的插入已回滚）

**为什么关键**：跨表操作必须原子，任何部分失败不留垃圾数据。

---

### S7: withTransaction 成功时提交

**前置**：初始化数据库

**操作**：`withTransaction(fn)` 中插入合法的 A 行和 B 行

**验证**：
- 不抛出错误
- A 和 B 行均在表中可查

**为什么关键**：验证正常路径，确保 COMMIT 实际执行。

---

### S8: SQLITE_BUSY 触发重试并最终成功

**前置**：模拟 SQLite 返回 `SQLITE_BUSY`（前 N-1 次），第 N 次成功

**验证**：
- 操作最终成功，不抛出错误
- 重试间隔包含 jitter（每次延迟不完全相同）

**为什么关键**：高频读写场景下 busy retry 是稳定性保障。

---

### S9: 重试耗尽后抛出 DatabaseBusyError

**前置**：模拟 SQLite 始终返回 `SQLITE_BUSY`

**验证**：抛出 `DatabaseBusyError`，不静默忽略，错误类型可被 `instanceof` 判断

**为什么关键**：调用方必须能明确感知写入失败，而不是静默丢数据。

---

### S10: initDatabase 前调用 getDatabase 抛明确错误

**前置**：未调用 `initDatabase()`（或使用全新的模块实例）

**验证**：
- `getDatabase()` 抛出 `DatabaseNotInitializedError`
- 错误信息明确指示"需要先调用 initDatabase()"

**为什么关键**：调用顺序错误应快速失败，而不是返回 `null` / `undefined` 导致后续隐性崩溃。

---

## 三、Integration Points（集成点测试）

### 与 runtime/daemon 或 CLI 后端入口的集成

**验证重点**：
- 后端入口启动序列中，`initDatabase()` 在任何业务模块可用之前完成
- 后端入口退出时，`closeDatabase()` 在进程退出前被调用

**迁移失败预期**：`initDatabase()` 抛出 `MigrationError` 时，后端入口启动流程中止，不进入服务状态

---

### 与业务模块（session / message 等）的集成

**验证重点**：
- 业务模块通过 `getDatabase()` + `schema` 能成功读写各自的表
- 业务模块的 INSERT/UPDATE/DELETE 在 WAL 模式下，多次操作后数据一致

**测试方式**：业务模块的集成测试使用**真实的 database 模块**（不 mock），通过内存 SQLite 或临时文件初始化

**不 mock 的理由**：
- mock database 模块会掩盖 schema 不匹配、迁移漏执行、外键约束绕过等真实问题
- database 模块的价值就在于 schema 和 pragma 的正确性，mock 掉后集成测试失去意义

---

## 四、Verification Strategy（验证策略）

### 测试环境

| 场景 | 测试环境 | 说明 |
|------|----------|------|
| S1（WAL pragma） | 临时文件 | SQLite 内存库不支持 WAL，必须用真实文件 |
| S2-S7 / S10 | 内存数据库（`:memory:`）或临时文件 | 速度快，适合验证迁移、事务、初始化错误 |
| S8-S9（BUSY retry） | fake retry closure + 临时文件集成补充 | 单元层验证重试策略；集成层可用两个连接制造锁冲突 |
| 路径管理 | 临时文件（`os.tmpdir()`）| 验证 XDG 路径和环境变量覆盖 |
| WAL 文件行为 | 临时文件 | 验证 `.db-wal` / `.db-shm` 是否生成 |

迁移、pragma、事务和 schema 集成测试不 mock `better-sqlite3` 或 `drizzle-orm`，使用真实库执行。BusyRetry 的重试策略可以用 fake operation closure 做单元测试；另外用临时文件数据库和两个连接补一条真实锁冲突集成测试。

### 测试隔离

- 每个测试用例使用独立的内存数据库或临时文件数据库，避免状态污染
- 在每个 test suite 的 `beforeEach` 中调用 `initDatabase()`，`afterEach` 中调用 `closeDatabase()`

### 自动化优先

所有 S1-S10 场景均适合自动化测试，无需人工验证。建议在 CI 中每次 PR 自动运行。

唯一建议手动关注的场景：WAL 模式在 Windows 环境下的行为（部分 Windows 环境的文件锁语义可能与 Linux/macOS 有差异），可在 CI 矩阵中覆盖三个平台。

---

## 五、文档自检

- [x] 所有关键职责（D1/D3/D4/D5/D6）都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期（MigrationError/DatabaseBusyError/DatabaseNotInitializedError）
- [x] 避免了与具体实现细节的绑定（不要求特定测试框架）
- [x] 不 mock 数据库驱动的理由明确
- [x] 测试策略与 dfd-interface.md 中的关键数据流对应
- [x] 测试隔离策略明确（每个用例独立内存 DB）
