# storage 模块 architecture.md

本文档描述 `services/storage` 模块在引入 `services/database` 后的内部架构。storage 不再承载 session/message/part 等结构化数据，而是专注于文件对象、大对象和调试 blob。

---

## 一、Architecture Overview（总体架构）

storage 模块采用**薄文件对象层**架构：上层模块提供 `StorageKey` 和内容类型，storage 负责路径解析、目录创建、文件级锁、原子写入和内容读写。

```
snapshot / runtime/tasks / artifact producers
        │
        │ readText / writeText / readBytes / writeBytes / readJson / writeJson
        ▼
┌───────────────────────────────────────────────────────────────┐
│                       services/storage                         │
│                                                               │
│  ┌────────────────┐   ┌────────────────┐   ┌───────────────┐ │
│  │ StorageFacade  │──▶│ PathResolver   │──▶│ FileSystem    │ │
│  │ public API     │   │ key -> path    │   │ fs/promises   │ │
│  └───────┬────────┘   └────────────────┘   └───────────────┘ │
│          │                                                    │
│          ▼                                                    │
│  ┌────────────────┐   ┌────────────────┐   ┌───────────────┐ │
│  │ ContentCodec   │   │ AtomicWriter   │   │ LockManager   │ │
│  │ text/bytes/json│   │ temp + rename  │   │ file rw lock  │ │
│  └────────────────┘   └────────────────┘   └───────────────┘ │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
XDG data dir / storage / ...
```

### 主要组件

| 组件 | 职责 |
|------|------|
| **StorageFacade** | 对外 API，协调路径解析、锁、读写和错误转换 |
| **PathResolver** | 将 `StorageKey` 映射为存储根目录内的安全路径 |
| **ContentCodec** | text / bytes / json 三类内容的编码和解码 |
| **AtomicWriter** | 通过临时文件 + rename 保证单文件写入不暴露半截内容 |
| **LockManager** | 文件级读写锁，多读单写，写者优先 |
| **Errors** | `NotFoundError`、`InvalidStorageKeyError` 等结构化错误 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Facade 模式

StorageFacade 是唯一公共入口。调用方不直接访问 PathResolver、LockManager 或 AtomicWriter，避免每个业务模块重复实现文件安全细节。

### 2. Adapter / Codec 分离

text、bytes、json 的处理放在 ContentCodec 中。storage 只知道内容格式，不知道业务语义。`readJson()` 是调试 dump 和迁移备份的便利接口，不表示 session/message 回到 JSON 文件存储。

### 3. 原子写入

写入时先写临时文件，再 rename 到目标路径。这样读者不会读到半截文件。多文件原子事务不属于 storage 职责，跨对象一致性由上层通过 database 事务或补偿逻辑处理。

### 4. 与 database 平行而非替代

database 负责结构化数据、索引、查询和事务；storage 负责大对象内容。典型协作是 snapshot：`snapshot_patch` 表在 database 中保存 artifact 路径，实际 diff 内容由 storage 保存。

---

## 三、Module Structure & File Layout（模块结构）

```
src/services/storage/
├── index.ts           # 公共 API 导出
├── storage.ts         # StorageFacade 实现
├── path-resolver.ts   # StorageKey -> 绝对路径
├── codec.ts           # text / bytes / json 编解码
├── atomic-writer.ts   # 临时文件 + rename
├── lock-manager.ts    # 文件级读写锁
├── types.ts           # StorageKey / StorageOptions / ContentKind
├── errors.ts          # NotFoundError / InvalidStorageKeyError
└── __tests__/
```

### 对外稳定接口

- `readText(key)` / `writeText(key, content)`
- `readBytes(key)` / `writeBytes(key, content)`
- `readJson<T>(key)` / `writeJson<T>(key, value)`
- `updateJson<T>(key, fn)`
- `exists(key)` / `remove(key)` / `list(prefix)`

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1：文件对象而非结构化仓储

**当前选择**：storage 不再提供 session/message/part 的仓储语义。

**理由**：这些数据需要按 session、时间、status 等字段查询，也需要外键和事务，属于 `services/database`。storage 只适合通过 key 定位并整体读取的文件对象。

### 约束 2：Key 安全边界

`StorageKey` 的每个 segment 必须是普通文件名片段，不允许包含路径分隔符、`.`、`..` 或空字符串。PathResolver 必须保证最终路径位于 storage root 内。

### 约束 3：单文件原子性

storage 保证单个对象写入原子，不保证多个对象之间的事务。如果需要“DB 元数据 + artifact 文件”的一致性，由调用方采用“先写临时 artifact，再写 DB 指针，失败后清理”的补偿策略。

### 约束 4：本地文件系统优先

MVP 只支持本地文件系统。S3/R2 等远程对象存储可以在未来通过 adapter 扩展，但不进入当前架构。

---

## 五、与关键模块的集成

| 模块 | 使用方式 |
|------|----------|
| `snapshot` | 将 patch diff / artifact 内容写入 storage，DB 中只保存路径指针 |
| `runtime/tasks` | 将 stdout/stderr、长期任务输出日志写入 storage |
| `services/database` | 不直接依赖 storage；业务模块同时使用二者完成“元数据 + 大对象”存储 |

---

## 六、文档自检

- [x] 明确 storage 已从通用 JSON 仓储收窄为文件对象存储
- [x] 未再把 session/message 作为 storage 的主要消费者
- [x] 与 database 的职责边界清晰
- [x] 单文件原子性与多文件非事务边界已说明
