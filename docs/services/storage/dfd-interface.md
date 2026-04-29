# storage 模块 dfd-interface.md

本文档描述 `services/storage` 的数据流和对外接口。storage 只处理文件对象内容，不处理 session/message/part 等结构化业务表。

---

## 一、Context & Scope（上下文与范围）

```
snapshot / runtime/tasks / debug dump producer
        │
        │ StorageKey + content
        ▼
┌─────────────────────────────────────────────────────────────┐
│ services/storage                                             │
│  PathResolver → LockManager → ContentCodec → AtomicWriter    │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
local file system under XDG data dir
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| `snapshot` | 调用 storage | 写入和读取 patch artifact |
| `runtime/tasks` | 调用 storage | 写入后台任务 stdout/stderr |
| `services/database` | 无直接调用 | database 保存 artifact 路径指针，storage 保存内容 |

---

## 二、Data Flow Description（数据流）

### 2.1 写入文本/二进制对象

```
调用方
  │ writeText(key, content) / writeBytes(key, bytes)
  ▼
StorageFacade
  │ validate StorageKey
  ▼
PathResolver
  │ key -> StorageLocation（必须在 storage root 内）
  ▼
LockManager
  │ 获取写锁
  ▼
AtomicWriter
  │ 写入临时文件
  │ rename 到目标路径
  ▼
释放写锁并返回
```

**关键语义**：
- 写入成功前不会暴露半截目标文件
- 单个对象写入是原子的
- 多对象一致性由调用方负责

### 2.2 读取文本/二进制对象

```
调用方
  │ readText(key) / readBytes(key)
  ▼
PathResolver
  │ validate + resolve
  ▼
LockManager
  │ 获取读锁
  ▼
fs.readFile
  │ 按接口解码为 string 或 bytes
  ▼
释放读锁并返回
```

**关键语义**：
- 文件不存在时抛出 `NotFoundError`
- storage 不解析业务内容

### 2.3 JSON blob 写入和更新

```
writeJson(key, value)
  → JSON.stringify(value, null, 2)
  → writeText(key, json)

updateJson(key, fn)
  → 获取写锁
  → read + JSON.parse
  → fn(draft)
  → JSON.stringify
  → atomic write
  → 释放写锁
```

**关键语义**：
- JSON helper 仅用于调试 dump、迁移备份、轻量 blob
- 不用于 session/message/part/run_ledger 等结构化数据

### 2.4 list / exists / remove

```
list(prefix)
  → resolve prefix dir
  → 遍历目录
  → 返回 StorageKey[]

exists(key)
  → resolve key
  → fs.access
  → boolean

remove(key)
  → resolve key
  → fs.rm({ force: true })
```

**关键语义**：
- `list(prefix)` 只提供 key 前缀列举，不提供字段过滤、排序或 JOIN
- 需要查询能力时，应在 database 中维护索引

---

## 三、Interface Definition（接口定义）

```typescript
type StorageKey = readonly string[]

interface Storage {
  readText(key: StorageKey): Promise<string>
  writeText(key: StorageKey, content: string, options?: WriteOptions): Promise<void>

  readBytes(key: StorageKey): Promise<Uint8Array>
  writeBytes(key: StorageKey, content: Uint8Array, options?: WriteOptions): Promise<void>

  readJson<T>(key: StorageKey): Promise<T>
  writeJson<T>(key: StorageKey, value: T, options?: WriteOptions): Promise<void>
  updateJson<T>(key: StorageKey, fn: (draft: T) => void): Promise<T>

  exists(key: StorageKey): Promise<boolean>
  remove(key: StorageKey): Promise<void>
  list(prefix: StorageKey): Promise<StorageKey[]>
}

interface WriteOptions {
  extension?: string
  contentType?: string
}
```

### 错误类型

| 错误 | 触发条件 |
|------|----------|
| `NotFoundError` | 读取不存在的对象 |
| `InvalidStorageKeyError` | key 非法或路径逃逸 |
| `StorageWriteError` | 写入失败且无法完成原子替换 |

---

## 四、Data Ownership & Responsibility（数据归属）

| 职责 | 负责模块 | 不负责模块 |
|------|----------|------------|
| artifact 内容读写 | storage | database |
| artifact 元数据、路径指针、保留策略 | 调用方业务模块 / database | storage |
| session/message/run 等结构化表 | database + 对应业务模块 | storage |
| 文件对象事件发布 | 调用方业务模块 | storage |

---

## 五、与 database 的协作案例

snapshot 创建 patch 时的推荐顺序：

1. snapshot 生成 patch 内容。
2. snapshot 调用 storage 写入 patch artifact。
3. storage 返回稳定 key / path。
4. snapshot 在 database 的 `snapshot_patch` 表写入 artifact 指针。
5. 如果第 4 步失败，snapshot 负责删除刚写入的 artifact 或标记为孤儿。

storage 不提供跨 DB 与文件系统的事务，因此补偿策略必须在调用方文档中说明。

---

## 六、文档自检

- [x] 数据流只描述文件对象读写
- [x] 接口包含 text / bytes / json 三类能力
- [x] 明确 list 不是 SQL 查询替代品
- [x] 明确 DB 元数据与 storage 内容的非事务边界
