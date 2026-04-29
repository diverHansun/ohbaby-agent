# database 模块 architecture.md

本文档描述 `services/database` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

database 模块采用**扁平基础设施架构**：内部无业务逻辑层，只有基础设施组件。各组件各司其职，由模块入口 `initDatabase()` 在启动时串联完成初始化。

```
┌───────────────────────────────────────────────────────────────────────┐
│                          database 模块                                 │
│                                                                        │
│  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ ConnectionManager│  │    Migrator     │  │       Schema         │  │
│  │                  │  │                 │  │                      │  │
│  │ - WAL 配置       │  │ - 读 migrations/│  │ - session 表         │  │
│  │ - FK pragma      │  │ - 比对版本记录  │  │ - message 表         │  │
│  │ - busy_timeout   │  │ - 事务执行迁移  │  │ - part 表            │  │
│  │ - Drizzle 包装   │  │ - 记录 migration│  │ - run_ledger 表      │  │
│  │ - getDatabase()  │  │   表            │  │ - scheduler_job 表   │  │
│  │ - closeDatabase()│  └─────────────────┘  │ - snapshot_* 表      │  │
│  └──────────────────┘                       │ - migration 表       │  │
│           │                                 └──────────────────────┘  │
│           │                                          ↑                │
│  ┌──────────────────┐  ┌─────────────────┐    业务模块 import schema  │
│  │   BusyRetry      │  │ TransactionHelper│   构造类型安全查询         │
│  │                  │  │                  │                            │
│  │ - 捕获 BUSY      │  │ - withTransaction│                            │
│  │ - jitter 重试    │  │ - 失败自动回滚   │                            │
│  │ - 耗尽抛出       │  └─────────────────┘                            │
│  │   DatabaseBusy-  │                                                 │
│  │   Error          │                                                 │
│  └──────────────────┘                                                 │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                       模块入口 (index.ts)                        │  │
│  │  initDatabase(options?) → ConnectionManager + Migrator → 就绪   │  │
│  │  getDatabase()         → DrizzleInstance                        │  │
│  │  closeDatabase()       → 优雅关闭连接                           │  │
│  │  withTransaction(fn)   → 事务包装                               │  │
│  │  export schema         → 所有表的 Drizzle 定义                  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │  better-sqlite3  │
                      │  SQLite .db 文件 │
                      └──────────────────┘
```

### 组件职责划分

| 组件 | 职责 |
|------|------|
| **ConnectionManager** | 创建 better-sqlite3 连接、配置 WAL/FK/busy_timeout pragma、提供 Drizzle 实例、优雅关闭 |
| **Migrator** | 读取 `migrations/` 目录、比对已执行版本、按顺序在事务中执行 pending 迁移、记录到 `migration` 表 |
| **Schema** | 所有数据库表的 Drizzle 定义，是全局 schema 的单一来源 |
| **TransactionHelper** | `withTransaction()` 封装：失败时自动 ROLLBACK，成功时 COMMIT |
| **BusyRetry** | 捕获 `SQLITE_BUSY`，带 jitter 重试 N 次，耗尽后抛出 `DatabaseBusyError` |
| **模块入口** | 串联启动流程；暴露对外 API；是唯一对外出口 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 进程级连接（Process-scoped Connection）

**使用理由**：
- G1 要求单个后端入口内共享同一个 SQLite 连接，防止同一进程内多个 `better-sqlite3` 实例竞争写锁
- 业务模块通过 `getDatabase()` 获取同一 Drizzle 实例，连接生命周期由 database 模块统一管理

**实现特征**：
- `ConnectionManager` 在模块内持有单一连接实例
- `initDatabase()` 幂等，重复调用不创建新连接
- `getDatabase()` 在未初始化时抛出 `DatabaseNotInitializedError`，快速暴露调用顺序错误

**依赖注入边界**：
- 生产路径使用进程级连接，业务模块可直接 `import { getDatabase }`，减少样板代码
- 测试路径允许 `initDatabase({ dbPath })` 指向临时文件或内存库，用真实 database 模块验证 schema 和 pragma
- 不把连接实例注入到每个业务模块，是为了避免业务层管理基础设施生命周期

### 2. 未使用 Repository 模式

**理由**：
- `goals-duty.md` N2 明确声明：不为每张表提供 CRUD 包装
- Repository 是业务模块（session-store、message-store 等）的职责
- database 模块只导出 Drizzle 实例和 schema，不参与查询逻辑

**带来的好处**：
- database 模块与业务逻辑零耦合，可被任意业务模块导入而不产生循环依赖

### 3. Migration Script Pattern（版本化迁移 + Append-Only）

**使用理由**：
- G4 要求迁移可追溯、幂等，支持 schema 演进
- `migrations/` 目录下的文件按序号命名（如 `001_initial.sql`），每次变更新增文件，不修改历史文件
- 与 `migration` 表对比后只执行 pending 迁移

**未使用 Drizzle Kit 自动 diff 生成**：
- 自动 diff 在 daemon 启动时运行存在风险（可能意外推断出删除列的操作）
- 手写迁移脚本更可控，适合生产环境渐进式变更

### 4. 双层 Busy 保障（SQLite timeout + 应用层 Retry）

**使用理由**：
- G2 要求在高频读写时处理临时锁冲突
- `PRAGMA busy_timeout = 5000` 让 SQLite 在 OS 层最多等待 5 秒
- 超时后应用层再 retry N 次，每次加入随机 jitter，避免多个调用方或意外多进程同时重试形成"惊群"

**jitter 设计理由**：防止多个调用方或意外多进程在完全相同时刻重试，降低竞争加剧的概率。正常架构不鼓励多进程写同一 DB；BusyRetry 是防御性保护，不是多进程写入支持。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/services/database/
├── index.ts              # 模块入口：唯一对外出口，导出全部公共 API
├── connection.ts         # ConnectionManager：连接创建、pragma 配置
├── schema.ts             # 所有表的 Drizzle Schema 定义（单一来源）
├── migrator.ts           # Migrator：读取迁移文件、比对版本、执行迁移
├── transaction.ts        # withTransaction() 实现
├── retry.ts              # BusyRetry：SQLITE_BUSY 重试逻辑
├── errors.ts             # DatabaseBusyError / MigrationError / DatabaseNotInitializedError
├── migrations/           # SQL 迁移文件（append-only，不可修改已有文件）
│   ├── 001_initial.sql
│   └── ...
└── __tests__/
    ├── connection.test.ts
    ├── migrator.test.ts
    └── transaction.test.ts
```

### 各文件职责

| 文件 | 定位 | 对外暴露 |
|------|------|----------|
| `index.ts` | 公共接口 | `initDatabase`, `getDatabase`, `closeDatabase`, `withTransaction`, `schema`, error classes |
| `connection.ts` | 核心基础设施 | 内部 |
| `schema.ts` | Schema 所有权 | 内部（通过 index.ts 重新导出 `schema`） |
| `migrator.ts` | 启动时执行 | 内部 |
| `transaction.ts` | 工具函数 | 内部 |
| `retry.ts` | 工具函数 | 内部 |
| `errors.ts` | 错误类型 | `DatabaseBusyError`, `MigrationError`, `DatabaseNotInitializedError` |
| `migrations/` | 变更历史 | 只读数据，不导出 |

### 对外稳定接口

以下内容构成公共 API，修改需谨慎：

- `initDatabase(options?)`：初始化数据库，运行迁移
- `getDatabase()`：获取 Drizzle 实例
- `closeDatabase()`：优雅关闭
- `withTransaction(fn)`：事务辅助函数
- `schema`：所有表的 Drizzle 定义对象（业务模块导入后构造查询）
- 错误类型（`DatabaseBusyError` 等）

### 内部实现（可自由重构）

- `ConnectionManager` 的 pragma 配置细节
- `Migrator` 的版本比对算法
- `BusyRetry` 的 jitter 公式和重试间隔
- `migrations/*.sql` 的内容（已执行的迁移不可修改，但 Migrator 实现可重构）

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1：better-sqlite3（同步）vs sqlite3（异步回调）

**当前选择**：better-sqlite3（同步 API）

**代价**：
- 写操作期间阻塞 Node.js 事件循环（I/O 等待期间）
- 不适合在 Worker Thread 之外执行大量并发写入

**理由**：
- ohbaby-agent 以单后端入口调度写入，不需要高度并发写入
- 同步事务语义更清晰：无需 async/await 链，事务边界天然明确
- better-sqlite3 性能优于 sqlite3（无 IPC 往返开销）

### 约束 2：Schema 集中定义 vs 分散定义

**当前选择**：所有表的 schema 集中在 `schema.ts`（G3）

**代价**：
- 新增业务表时需要修改 database 模块的 schema 文件
- database 模块对业务模块有单向"知晓"（知道表的结构，但不知道业务规则）

**理由**：
- 分散 schema 会导致迁移文件和表定义分离，产生不一致风险
- 集中 schema 是保证迁移可靠性的前提
- 单向依赖（business → database）比双向耦合更安全

### 约束 3：手写 SQL 迁移 vs Drizzle Kit 自动生成

**当前选择**：手写 SQL 迁移文件

**代价**：
- 每次 schema 变更需要同时更新 Drizzle 定义和迁移文件，存在遗漏风险

**理由**：
- 自动 diff 在 daemon 启动时运行可能意外推断出危险操作（如删除列）
- 手写迁移在 code review 时更易察觉破坏性变更
- 迁移文件作为 schema 演进的显式历史记录

### 约束 4：单 SQLite 文件 vs 多文件分库

**当前选择**：单一 SQLite 文件（N5）

**代价**：
- 所有表共享同一写锁，高频并发写入存在竞争
- 不支持多租户分库场景

**理由**：
- MVP 场景下单进程单文件足够
- YAGNI：多文件会显著增加连接管理复杂度
- WAL 模式下单写多读性能可接受

---

## 五、文档自检

- [x] 每个组件存在的理由可以清楚说明，并可追溯到 goals-duty.md 中的职责
- [x] 不包含业务逻辑，无 Repository 层
- [x] 设计模式选择均有明确理由，无"因为优雅"而引入的复杂度
- [x] 明确说明了被放弃的方案及其代价（异步 API、自动迁移生成、多文件）
- [x] 架构支持 KISS 和 YAGNI 原则
