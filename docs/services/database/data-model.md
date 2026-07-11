# database 模块 data-model.md

本文档定义 `services/database` 模块的核心概念，为业务模块使用 Drizzle 实例和 schema 提供统一的认知语言。

---

## 一、Core Concepts（核心概念）

### DatabaseConnection（数据库连接）

ohbaby-agent 进程持有的**唯一** SQLite 连接实例，由 `better-sqlite3` 创建，经 `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`、`PRAGMA busy_timeout = 5000` 初始化。

业务模块通过 `getDatabase()` 获取 Drizzle 包装后的连接，不直接操作 `better-sqlite3` 实例。

**关键属性**：
- 全进程唯一，由 `initDatabase()` 创建，`closeDatabase()` 销毁
- 已内置 WAL/FK/busy_timeout 配置，业务模块无需关心 pragma
- 生命周期归属 database 模块，业务模块只"借用"，不拥有

---

### Schema（表结构定义集合）

`schema.ts` 中所有 Drizzle 表定义的集合，是整个系统所有数据库表结构的**单一来源**。

业务模块通过 `import { schema } from '@/services/database'` 获取引用，用它构造类型安全的 Drizzle 查询：

```typescript
const db = getDatabase()
const rows = db.select().from(schema.session).where(eq(schema.session.status, 'active'))
```

**包含的表及归属**：

| 表名 | 数据归属模块 | 说明 |
|------|------------|------|
| `session` | services/session | 会话元数据 |
| `message` | core/message | 消息索引字段 + data JSON |
| `part` | core/message | Part 索引字段 + data JSON |
| `run_ledger` | runtime/run-ledger | Run 状态账本 |
| `snapshot_checkpoint` | snapshot | 检查点元数据与索引 |
| `snapshot_patch` | snapshot | Patch 元数据（大对象路径指针） |
| `migration` | services/database | 迁移版本记录（自身维护） |

> `scheduler_job` 不在当前 schema：历史表已由 migration `004_drop_scheduler_job` 删除。未来实现 session 级 `/loop` 时，必须与 SchedulerStore 和新 migration 同批恢复，并绑定 `scope_key + session_id`。

**schema 所有权说明**：
- database 模块拥有 schema **定义**（列名、类型、索引、外键）
- 各业务模块拥有对应表的**业务规则**（何时插入、何时删除、字段含义）

---

### Migration（版本化迁移）

对 Schema 的一次**不可变的版本化变更**，以 SQL 文件形式存储在 `migrations/` 目录下。

**关键属性**：
- 按版本顺序执行；当前 migration 定义在 `migrations.ts`。历史 `scheduler_job` 曾被加入，随后由 `004_drop_scheduler_job` 显式删除。
- Append-Only：一旦文件被提交并执行，不可修改，只能新增文件
- 每条迁移在事务中执行：全成功或全回滚
- 执行后记录在 `migration` 表，防止重复执行
- 迁移失败阻止应用启动（抛出 `MigrationError`）

---

### Transaction（事务）

一组必须**原子执行**的 SQL 操作序列。由 `withTransaction(fn)` 封装提供。

**使用场景**：跨表写操作需要原子性保障时，例如：
- 创建 session 的同时初始化其相关状态
- snapshot 创建时同时写入 `snapshot_checkpoint` 和 `snapshot_patch` 两张表

`fn` 内的操作要么全部 COMMIT，要么在异常时全部 ROLLBACK，原始异常向上透传。

---

## 二、Entity / Value Object 区分

### Entity（有身份、有生命周期）

| 概念 | 身份标识 | 生命周期 |
|------|----------|----------|
| DatabaseConnection | 进程级单例，无显式 ID | 随 daemon 或 CLI 后端入口启动/退出 |
| Migration | `version` 字段（如 `001`）| 执行后不可变，永久记录 |

### Value Object（无身份、可替换）

| 概念 | 说明 |
|------|------|
| Schema | 随代码版本部署，不持有运行时状态 |
| Transaction | 无 ID，按需创建，`withTransaction()` 返回后即消亡 |

---

## 三、Key Data Fields（关键数据字段）

### migration 表

| 字段 | 含义 |
|------|------|
| `version` | 迁移版本号（如 `001`），主键，确保每条迁移只执行一次 |
| `applied_at` | Unix 时间戳（毫秒），记录迁移成功执行的时间 |

### 关系型列 vs JSON 列（data）的划分原则

database 模块在 schema 中规定了统一的列分配原则，业务模块不自行决定字段去向：

| 类型 | 放置位置 | 判断标准 |
|------|----------|----------|
| **关系型列** | 独立列（带索引/外键） | 需要在 SQL 中过滤、排序、JOIN，或作为外键引用 |
| **JSON 列（`data`）** | `TEXT` 类型的 JSON 字符串 | 复杂领域对象，不需要 SQL 查询，保留类型演进弹性 |

**示例**：

```
message 表
├── id          TEXT PRIMARY KEY          ← 关系型列（主键，被 part.message_id 引用）
├── session_id  TEXT NOT NULL REFERENCES  ← 关系型列（外键，用于按会话查询）
├── role        TEXT NOT NULL             ← 关系型列（用于过滤 user/assistant）
├── created_at  INTEGER NOT NULL          ← 关系型列（用于时间排序）
└── data        TEXT NOT NULL             ← JSON 列（存储完整 Message 对象，含 tokens、cost 等）
```

---

## 四、Lifecycle & Ownership（生命周期与归属）

```
进程启动
   │
   ├── runtime/daemon 或 CLI 后端入口调用 initDatabase()
   │       ├── ConnectionManager 创建 better-sqlite3 连接
   │       ├── 执行 WAL / FK / busy_timeout pragma
   │       └── Migrator 运行所有 pending 迁移
   │           ├── 成功 → migration 表记录版本
   │           └── 失败 → 抛出 MigrationError，后端入口启动失败
   │
   ├── getDatabase() 可用
   │       └── 业务模块使用 Drizzle 实例 + schema 执行查询和写入
   │
   └── 进程退出
          └── runtime/daemon 或 CLI 后端入口调用 closeDatabase()
                  └── ConnectionManager 关闭连接并释放 SQLite 文件句柄
```

**数据归属规则**：
- `DatabaseConnection` 的创建/销毁 → database 模块
- `migration` 表的写入 → database 模块（Migrator）
- 所有业务表（session/message/part/run_ledger 等）的行数据 → 各自业务模块
- schema 定义（列结构、索引、外键）→ database 模块
- 业务字段含义和业务操作规则 → 各自业务模块

---

## 五、文档自检

- [x] 所有概念可用自然语言解释
- [x] 无"为了设计而设计"的抽象
- [x] 所有概念在 architecture.md 和 dfd-interface.md 中有对应位置
- [x] 明确区分了 database 模块拥有的概念（Connection/Schema/Migration）与业务模块拥有的数据（各表的行数据）
- [x] 关系型列 vs JSON 列的划分原则明确，供 schema 设计和业务模块参考
