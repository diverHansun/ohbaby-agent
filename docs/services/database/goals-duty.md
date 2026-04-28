# database 模块 goals-duty.md

本文档定义 `services/database` 模块的设计目标与职责边界。

---

## 一、模块定位

**一句话说明**：database 模块为 ohbaby-agent 提供共享的 SQLite 关系型数据库基础设施，管理连接、Schema 定义、迁移、事务和并发安全，是所有需要查询、索引和关系型存储的模块的底层依赖。

**如果没有这个模块**：
- 各业务模块需要各自实现 SQLite 连接、WAL 配置、busy retry，逻辑重复
- 多模块并发访问同一 DB 文件时缺乏统一的连接管理，导致锁冲突
- Schema 演进和迁移分散在各处，难以维护版本一致性
- 事务边界不清晰，跨表操作无法原子化

**不是 services/storage 的升级版**：
- `services/storage` 是面向对象/文件的 KV 存储，继续管理大对象、patch artifact、日志输出
- `services/database` 是关系型数据库，面向查询、索引、事务和结构化数据
- 两者并存，职责互补

---

## 二、Design Goals（设计目标）

### G1: 单一进程入口，统一连接管理

在 daemon 模式下，只有 ohbaby-agent 后端进程直接写入 SQLite；CLI/TUI/Web/SDK 通过后端接口提交命令，不直接打开 DB 写入。后端进程内部共享一个 SQLite 连接实例，由 database 模块持有和管理。所有业务模块通过 database 模块获取 Drizzle 实例，不自行创建连接，避免连接生命周期和锁策略分散。

### G2: WAL 模式 + Busy Retry

启用 WAL（Write-Ahead Logging）模式，允许一个写者与多个读者更好地并发。SQLite 仍然会串行化写事务；database 模块通过 `busy_timeout` 和带 jitter 的重试处理临时锁冲突，避免后台任务、scheduler、UI 查询在高频读写时互相打断。

### G3: Schema 所有权集中

所有表的 Drizzle Schema 定义统一在 database 模块中维护，业务模块通过导入 schema 来构造查询。schema 不分散在各业务模块内，确保 schema 演进有单一来源。

### G4: 迁移管理

使用版本化迁移脚本管理 Schema 变更：
- 每次 Schema 变更通过新增迁移文件完成，不直接修改现有迁移
- 应用启动时自动运行 pending 迁移，确保 DB 版本与代码同步
- 迁移记录持久化到 `migration` 表

### G5: 外键约束默认开启

SQLite 的外键约束默认关闭，database 模块在连接初始化时显式开启（`PRAGMA foreign_keys = ON`），确保引用完整性由 DB 层而非应用层保证。

### G6: 关系 + JSON 混合存储模式

核心索引字段（id、sessionId、timestamps、status 等）使用关系型列存储，供 SQL 查询使用；复杂的领域数据（消息内容、Part 数据、配置对象）存入 JSON column，保留类型演进弹性。

---

## 三、Duties（职责）

### D1: 连接初始化与配置

负责创建和配置 SQLite 连接：
- 使用 `better-sqlite3` 创建同步连接
- 执行 `PRAGMA journal_mode = WAL`
- 执行 `PRAGMA foreign_keys = ON`
- 执行 `PRAGMA busy_timeout = 5000`（毫秒）
- 提供 `getDatabase()` 返回已初始化的 Drizzle 实例
- 提供 `closeDatabase()` 用于进程退出时优雅关闭

### D2: Schema 定义（Drizzle）

集中定义所有数据库表的 Drizzle Schema：

| 表名 | 归属模块 | 说明 |
|------|---------|------|
| `session` | services/session | 会话元数据 |
| `message` | core/message | 消息索引字段 + data JSON |
| `part` | core/message | Part 索引字段 + data JSON |
| `run_ledger` | runtime/run-ledger | Run 状态账本（最小记录） |
| `snapshot_checkpoint` | snapshot | 检查点元数据与索引 |
| `snapshot_patch` | snapshot | Patch 元数据（大对象指针） |
| `scheduler_job` | runtime/scheduler | 用户可感知的 scheduled/reminder 调度承诺 |
| `migration` | services/database | 迁移版本记录 |

导出 `schema` 命名空间，供业务模块导入。

### D3: 迁移执行

在数据库初始化时运行迁移：
- 读取 `migrations/` 目录下的迁移文件（按版本号排序）
- 与 `migration` 表中已执行的记录对比，只运行 pending 迁移
- 每条迁移在事务中执行，失败时回滚并抛出错误，阻止应用启动
- 迁移完成后记录到 `migration` 表

### D4: 事务支持

提供事务辅助函数：
- `withTransaction(fn)`: 在单个事务中执行操作序列，失败时自动回滚
- 对于 `better-sqlite3` 同步 API，使用同步事务

### D5: Busy Retry

对写操作提供应用层 busy retry：
- 当 SQLite 返回 `SQLITE_BUSY` 时，最多重试 N 次
- 每次重试间隔加入随机 jitter，避免多个进程同时重试形成雪崩
- 重试耗尽后抛出明确的 `DatabaseBusyError`

### D6: 数据库文件路径管理

确定 SQLite 文件的存储路径：
- 遵循 XDG 规范，与 `services/storage` 使用相同的基础目录
- 默认路径：`{baseDir}/ohbaby-agent.db`
- 支持环境变量覆盖（`OHBABY_DB_PATH`）
- 应用启动时确保父目录存在

---

## 四、Non-Duties（非职责）

### N1: 不定义业务逻辑

message 的创建规则、session 的状态迁移、snapshot 的保留策略等业务规则，由各自业务模块负责。database 模块只提供 DB 操作能力。

### N2: 不封装查询 API

`session.list()`、`message.getBySessionId()` 等业务查询 API 由各自的 domain store / repository 层实现。database 模块只导出 schema 和 DB 实例，不为每张表提供 CRUD 包装。

### N3: 不管理大对象

patch artifact、task 输出日志、附件文件等大对象由 `services/storage` 管理。database 模块仅在 `snapshot_patch` 表中存储文件路径指针，不直接存储文件内容。

### N4: 不负责缓存

没有内存查询缓存层。缓存策略由上层业务模块根据需要自行实现。

### N5: 不支持多数据库文件

当前版本只管理一个 SQLite 文件。不支持多租户分库、分片等场景。

### N6: 不负责远程数据库

仅支持本地 SQLite。PostgreSQL、MySQL 等远程数据库不在当前职责范围内（预留接口扩展可能）。

---

## 五、设计约束与假设

### 约束

1. **单 daemon 写入口**：只有 ohbaby-agent 后端进程直接写 DB；其他前端或外部接口通过 daemon/server 间接操作。SQLite 层仍按一个写者 + 多个读者的规则序列化并发访问。
2. **同步驱动**：使用 `better-sqlite3`（同步 API），而非 `sqlite3`（异步回调），与 Node.js 主进程模型更匹配
3. **ORM**：使用 Drizzle ORM 作为类型安全的查询构建器
4. **JSON column 类型**：data 字段使用 `text` 类型存储 JSON 字符串，由应用层负责序列化/反序列化

### 假设

1. SQLite WAL 模式在目标平台（Linux/macOS/Windows）下稳定可用
2. `better-sqlite3` 与目标 Node.js 版本兼容
3. 存储设备支持文件锁（NFS 等网络文件系统不在支持范围内）

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `services/session` | 被依赖 | session-store 通过 database 模块读写 session 表 |
| `core/message` | 被依赖 | message-store 通过 database 模块读写 message/part 表 |
| `runtime/run-ledger` | 被依赖 | run-ledger 通过 database 模块读写 run_ledger 表 |
| `snapshot` | 被依赖 | snapshot-store 通过 database 模块读写 checkpoint/patch 表 |
| `runtime/scheduler` | 被依赖 | scheduler-store 通过 database 模块读写 scheduler_job 表 |
| `services/storage` | 无直接依赖 | 各自职责独立，共存互补 |
| `runtime/daemon` | 依赖 | daemon 在启动时调用 `initDatabase()`，退出时调用 `closeDatabase()` |

---

## 七、Schema 草稿（MVP）

```sql
-- session 表
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent TEXT,
  parent_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  data TEXT  -- JSON，存储扩展元数据
);

-- message 表
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  role TEXT NOT NULL,
  agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL  -- JSON，存储 Message 除索引列外的领域字段，不包含 Part 内容
);
CREATE INDEX idx_message_session_time ON message(session_id, created_at);

-- part 表
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL  -- JSON，存储完整 Part 对象
);
CREATE INDEX idx_part_message ON part(message_id, order_index);
CREATE INDEX idx_part_session ON part(session_id);

-- run_ledger 表（最小账本）
CREATE TABLE run_ledger (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  error TEXT
);
CREATE INDEX idx_run_ledger_session ON run_ledger(session_id, created_at);
CREATE INDEX idx_run_ledger_status ON run_ledger(status);

-- snapshot_checkpoint 表
CREATE TABLE snapshot_checkpoint (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT NOT NULL,
  workdir TEXT NOT NULL,
  workspace_source TEXT,
  message_cursor_before TEXT, -- JSON，Turn 开始时的 message cursor
  message_cursor_after TEXT,  -- JSON，Turn 结束时的 message cursor
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_snapshot_session ON snapshot_checkpoint(session_id, created_at);
CREATE INDEX idx_snapshot_run_turn ON snapshot_checkpoint(session_id, run_id, turn_id);

-- snapshot_patch 表
CREATE TABLE snapshot_patch (
  patch_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES snapshot_checkpoint(checkpoint_id),
  artifact_path TEXT,  -- 大对象存 services/storage 文件路径
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- scheduler_job 表（只存用户可感知的调度承诺；FollowUp 不持久化）
CREATE TABLE scheduler_job (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'scheduled' | 'reminder'
  session_id TEXT,
  next_run_at INTEGER NOT NULL,
  cron_expr TEXT,              -- 仅 kind='scheduled' 时有值
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'completed' | 'cancelled'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT  -- JSON，存储 job 配置与触发参数
);
CREATE INDEX idx_scheduler_next_run ON scheduler_job(next_run_at, status);
CREATE INDEX idx_scheduler_kind_status ON scheduler_job(kind, status);

-- migration 表
CREATE TABLE migration (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

---

## 八、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 明确区分了 database 模块与 storage 模块的职责边界
- [x] Schema 覆盖所有需要关系型存储的业务模块
- [x] 并发控制策略明确（WAL + busy retry）
- [x] 不承担业务逻辑，只提供 DB 基础设施
- [x] 迁移策略明确，支持版本演进
