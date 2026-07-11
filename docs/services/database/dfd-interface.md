# database 模块 dfd-interface.md

本文档描述 `services/database` 模块的数据流与对外接口。数据流优先，接口从属于数据流。

---

## 一、Context & Scope（上下文与范围）

### 模块位置

database 模块是 ohbaby-agent 系统中结构化数据存储的最底层基础设施。所有需要关系型存储的业务模块都单向依赖它，但 database 模块本身不依赖任何业务模块。

```
┌─────────────────────────────────────────────────────────────────┐
│              业务模块（消费层）                                    │
│  services/session  core/message  runtime/run-ledger  snapshot    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ getDatabase() + import { schema }
                           │ withTransaction(fn)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   services/database                              │
│  initDatabase / getDatabase / closeDatabase / withTransaction   │
│  schema（所有表的 Drizzle 定义）                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ better-sqlite3 同步 API
                           ▼
                  ┌──────────────────┐
                  │  SQLite .db 文件  │
                  └──────────────────┘
```

### 交互模块

| 外部模块 | 交互方向 | 交互内容 |
|----------|----------|----------|
| `runtime/daemon` / CLI entry | 输入（控制生命周期） | `initDatabase()` / `closeDatabase()` |
| `services/session` | 输入（数据读写） | 通过 Drizzle 实例读写 `session` 表 |
| `core/message` | 输入（数据读写） | 通过 Drizzle 实例读写 `message` / `part` 表 |
| `runtime/run-ledger` | 输入（数据读写） | 通过 Drizzle 实例读写 `run_ledger` 表 |
| `snapshot` | 输入（数据读写） | 通过 Drizzle 实例读写 `snapshot_checkpoint` / `snapshot_patch` 表 |
| SQLite 文件系统 | 输出 | 通过 `better-sqlite3` 读写 `.db` 文件 |

> `runtime/scheduler` 是未来消费者：当前 `scheduler_job` 已被 migration 004 删除。恢复时必须与 session 级 `/loop`、SchedulerStore 和 `scope_key + session_id` schema 同批落地。

### 本文档范围

- 描述 database 模块的初始化、查询、事务、关闭四个核心流程
- 定义对外暴露的接口及其语义
- 说明数据创建/更新/删除的责任边界
- 说明 database 与 services/storage 的互补关系

---

## 二、Data Flow Description（数据流描述）

### 2.1 初始化流程

```
runtime/daemon                   database 模块                    SQLite 文件
      │                               │                                │
      │  1. initDatabase(options?)    │                                │
      │──────────────────────────────>│                                │
      │                               │                                │
      │              2. ConnectionManager 创建 better-sqlite3 连接     │
      │                               │──────────────────────────────>│
      │                               │                                │
      │              3. 执行初始化 pragma                              │
      │                               │  PRAGMA journal_mode = WAL    │
      │                               │  PRAGMA foreign_keys = ON     │
      │                               │  PRAGMA busy_timeout = 5000   │
      │                               │──────────────────────────────>│
      │                               │                                │
      │              4. Migrator 读取 migrations/ 目录文件列表          │
      │              5. 查询 migration 表获取已执行版本号               │
      │                               │──────────────────────────────>│
      │                               │                                │
      │              6. 对每条 pending 迁移，在事务中执行：              │
      │                               │  BEGIN TRANSACTION             │
      │                               │  执行迁移 SQL 语句             │
      │                               │  INSERT INTO migration(version, applied_at)
      │                               │  COMMIT                       │
      │                               │──────────────────────────────>│
      │                               │                                │
      │  7. initDatabase() 完成       │                                │
      │<──────────────────────────────│                                │
```

**关键语义**：
- 迁移失败时立即 ROLLBACK 当条迁移，抛出 `MigrationError`（含失败版本号），daemon 启动失败
- `initDatabase()` 幂等：已执行的迁移被跳过，重复调用安全
- 初始化完成前，`getDatabase()` 不可用

---

### 2.2 业务模块查询流程（日常读写）

```
业务模块（如 message-store）       database 模块            SQLite 文件
         │                              │                        │
         │  1. import { getDatabase,    │                        │
         │              schema }        │                        │
         │   （模块加载时一次性导入）    │                        │
         │                              │                        │
         │  2. const db = getDatabase() │                        │
         │─────────────────────────────>│                        │
         │                              │                        │
         │  3. DrizzleInstance          │                        │
         │<─────────────────────────────│                        │
         │                              │                        │
         │  4. db.select()              │                        │
         │     .from(schema.message)    │                        │
         │     .where(eq(schema.message.sessionId, id))          │
         │──────────────────────────────────────────────────────>│
         │                              │                        │
         │  5. rows[]                   │                        │
         │<──────────────────────────────────────────────────────│
```

**关键语义**：
- `getDatabase()` 返回 Drizzle 实例，业务模块使用 `schema` 对象构造类型安全查询
- database 模块不参与查询逻辑，不知道业务意图
- `better-sqlite3` 的 API 是同步的，查询立即返回结果

---

### 2.3 事务流程（跨表原子写入）

```
业务模块（需要跨表原子写入）       database 模块            SQLite 文件
         │                              │                        │
         │  1. withTransaction(fn)      │                        │
         │─────────────────────────────>│                        │
         │                              │                        │
         │              2. BEGIN TRANSACTION                      │
         │                              │──────────────────────>│
         │                              │                        │
         │  3. fn(db) 被调用（db 即 Drizzle 实例）               │
         │<─────────────────────────────│                        │
         │                              │                        │
         │  4. 业务模块执行多条 SQL（如跨表 insert）              │
         │──────────────────────────────────────────────────────>│
         │                              │                        │
         │  5a. fn 正常返回             │                        │
         │              COMMIT          │                        │
         │                              │──────────────────────>│
         │                              │                        │
         │  5b. fn 抛出异常             │                        │
         │              ROLLBACK + 原始异常向上透传               │
         │<─────────────────────────────│                        │
```

**关键语义**：
- `fn` 内任何异常触发自动 ROLLBACK，不留下部分写入的数据
- ROLLBACK 后原始异常向上透传，业务模块可继续处理
- 业务模块无需手动 COMMIT / ROLLBACK

---

### 2.4 SQLITE_BUSY 重试流程

```
业务模块          BusyRetry           SQLite（临时锁占用）
   │                  │                          │
   │  写操作           │                          │
   │──────────────────────────────────────────── >│
   │                  │                          │
   │                  │         SQLITE_BUSY      │
   │                  │<─────────────────────────│
   │                  │                          │
   │         retry 1: sleep(baseDelay + jitter)  │
   │──────────────────────────────────────────── >│
   │                  │                          │
   │         retry 2: sleep(baseDelay*2 + jitter)│
   │──────────────────────────────────────────── >│
   │                  │                          │
   │         （第 N 次重试成功）                   │
   │<─────────────────────────────────────────────│
   │                  │                          │
   │         （重试 N 次仍 BUSY → DatabaseBusyError）
   │<─────────────────                           │
```

**关键语义**：
- `busy_timeout = 5000` 是 SQLite 层的等待上限，应用层 retry 是额外保障
- 每次重试间隔递增并加入随机 jitter，避免多个调用方或意外多进程同时重试
- 重试耗尽后抛出 `DatabaseBusyError`，不静默忽略
- Busy Retry 不表示支持多进程写入；它只处理临时锁冲突的恢复窗口

---

### 2.5 关闭流程

```
runtime/daemon             database 模块            SQLite 文件
      │                         │                        │
      │  closeDatabase()        │                        │
      │────────────────────────>│                        │
      │                         │                        │
      │           ConnectionManager 关闭 better-sqlite3  │
      │           （释放连接；必要时可执行 WAL checkpoint）│
      │                         │──────────────────────>│
      │                         │                        │
      │  void                   │                        │
      │<────────────────────────│                        │
```

**关键语义**：
- 关闭连接会释放 SQLite 持有的文件句柄；WAL 内容由 SQLite 保证可恢复
- 如实现层需要减小 WAL 文件，可在关闭前显式执行 checkpoint
- 在进程退出钩子中调用，避免连接长期悬挂

---

## 三、Interface Definition（接口定义）

### 3.1 initDatabase()

**语义**：初始化数据库连接，配置 pragma，运行 pending 迁移，使 `getDatabase()` 可用

**输入**：
```typescript
options?: {
  dbPath?: string  // 覆盖默认路径（默认：XDG 基础路径下的 ohbaby-agent.db）
}
// 环境变量 OHBABY_DB_PATH 优先于 options.dbPath
```

**输出**：`void`（同步，阻塞直到所有迁移执行完成）

**错误处理**：
- 迁移失败：抛出 `MigrationError`，包含失败的版本号和原始错误
- 路径不可达：向上抛出 I/O 错误

**调用时机**：daemon 或 CLI 后端入口启动序列中，在任何业务模块可用之前调用

---

### 3.2 getDatabase()

**语义**：获取已初始化的 Drizzle 实例，供业务模块构造查询

**输入**：无

**输出**：`BetterSQLite3Database`（Drizzle 包装后的 better-sqlite3 实例）

**前置条件**：`initDatabase()` 必须已成功调用

**错误处理**：
- 未初始化时调用：抛出 `DatabaseNotInitializedError`

---

### 3.3 closeDatabase()

**语义**：优雅关闭数据库连接，释放 SQLite 文件句柄；实现层可按需要执行 WAL checkpoint

**输入**：无

**输出**：`void`

**调用时机**：进程退出钩子中调用（如 `process.on('exit', closeDatabase)`）

---

### 3.4 withTransaction(fn)

**语义**：在单个事务中执行操作序列，失败时自动回滚

**输入**：
```typescript
fn: (db: BetterSQLite3Database) => T
// fn 接收 Drizzle 实例，在其中执行 SQL 操作
```

**输出**：`T`（fn 的返回值）

**同步特性**：同步执行（better-sqlite3 事务 API 为同步）

**行为**：
- fn 内抛出异常 → 自动 ROLLBACK → 原始异常向上透传
- fn 正常返回 → 自动 COMMIT → 返回 fn 的返回值

---

### 3.5 schema

**语义**：所有表的 Drizzle 定义对象，供业务模块构造类型安全查询

**类型**：Drizzle 表对象的命名空间集合

**使用示例**：
```typescript
import { getDatabase, schema } from '@/services/database'
import { eq } from 'drizzle-orm'

// 在业务模块的 store 中
const db = getDatabase()
const sessions = db
  .select()
  .from(schema.session)
  .where(eq(schema.session.projectId, projectId))
  .orderBy(schema.session.createdAt)
  .all()
```

---

### 3.6 错误类型

| 错误类 | 触发条件 | 含义 |
|--------|----------|------|
| `MigrationError` | 迁移 SQL 执行失败 | 包含失败的迁移版本号和原始错误，阻止启动 |
| `DatabaseBusyError` | SQLITE_BUSY 重试耗尽 | 写入失败，调用方需处理 |
| `DatabaseNotInitializedError` | `initDatabase()` 前调用 `getDatabase()` | 调用顺序错误，应快速暴露 |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| SQLite 文件 | database 模块（`initDatabase`） | 首次初始化时由 better-sqlite3 创建 |
| `migration` 表行 | database 模块（Migrator） | 每条迁移执行成功后写入 |
| `session` 表行 | services/session | 通过 Drizzle 实例写入 |
| `message` / `part` 表行 | core/message | 通过 Drizzle 实例写入 |
| `run_ledger` 表行 | runtime/run-ledger | 通过 Drizzle 实例写入 |
| `snapshot_*` 表行 | snapshot | 通过 Drizzle 实例写入 |

### 4.2 职责边界

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| 连接管理（创建/关闭/pragma） | database | 所有业务模块 |
| Schema 定义（列结构/索引/外键） | database | 所有业务模块 |
| 迁移执行与记录 | database | 所有业务模块 |
| WAL / FK / busy_timeout 配置 | database | 所有业务模块 |
| 业务查询 API（CRUD 方法） | 各业务模块 | database |
| 业务数据的创建/更新/删除规则 | 各业务模块 | database |
| 事件广播 | 各业务模块 | database |
| 大对象（artifact、日志文件） | services/storage | database |

### 4.3 与 services/storage 的边界

database 模块和 services/storage 模块是**平行的基础设施**，职责互补，不互相依赖：

| 维度 | services/database | services/storage |
|------|-------------------|------------------|
| 存储形式 | SQLite 关系型表 | 文件系统（KV 风格） |
| 查询能力 | SQL（过滤/排序/JOIN/事务） | 只支持 Key 前缀列举 |
| 典型数据 | session 元数据、message 索引、run 状态、scheduler 承诺 | patch artifact、task 日志、附件、调试 JSON |
| 事务支持 | 是 | 否（单文件原子写入） |
| 大对象支持 | 否（JSON 列存结构化数据） | 是（二进制/文本文件） |

**协作案例**：`snapshot_patch` 表存储 artifact 文件的路径指针（在 database），实际文件由 storage 管理。database 持有指针，storage 持有内容。

### 4.4 跨 database 与 storage 的一致性

database 不提供跨 SQLite 与文件系统的分布式事务。当业务模块需要同时写入 DB 元数据和 storage artifact 时，应采用补偿式一致性策略：

1. 先写入 storage artifact，得到稳定的 storage key / path。
2. 再在 database 事务中写入元数据和 artifact 指针。
3. 如果 DB 写入失败，由业务模块删除刚写入的 artifact，或标记为 orphan 等待清理。

这个模式的权威说明放在 `docs/services/storage/dfd-interface.md` 第五节“与 database 的协作案例”。database 只负责 DB 内事务；文件系统补偿由拥有业务语义的调用方负责。

---

## 五、文档自检

- [x] 可以清楚说明每条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流（初始化/查询/事务/关闭四个核心流程）
- [x] 数据责任边界清晰（database vs 业务模块，database vs storage）
- [x] 错误处理语义明确，无静默失败
- [x] 与 services/storage 的互补关系有明确说明
- [x] 跨 database 与 storage 的非事务补偿策略已说明
- [x] 接口定义关注语义，未绑定具体实现细节
