# storage 模块 data-model.md

本文档定义 `services/storage` 模块的核心数据类型。storage 的模型围绕“文件对象”而不是“业务实体”展开。

---

## 一、Core Concepts（核心概念）

| 概念 | 一句话说明 |
|------|-----------|
| **StorageKey** | 调用方传入的逻辑路径，由多个安全 segment 组成 |
| **StorageObject** | storage 管理的单个文件对象，可能是文本、bytes 或 JSON blob |
| **ContentKind** | 对象内容格式：text / bytes / json |
| **StorageLocation** | 解析后的绝对路径，只能位于 storage root 内 |
| **StorageRoot** | XDG data dir 下的 storage 根目录 |

---

## 二、StorageKey（存储键）

```typescript
type StorageKey = readonly string[]
```

Key 是逻辑地址，不是文件系统路径。每个 segment 必须满足：

- 非空字符串
- 不包含 `/`、`\`、平台路径分隔符
- 不能是 `.` 或 `..`
- 不负责表达扩展名，扩展名由写入接口或调用方约定决定

示例：

| Key | 典型用途 |
|-----|---------|
| `["snapshot", "patches", checkpointId, patchId]` | snapshot patch diff |
| `["tasks", taskId, "stdout"]` | 后台任务 stdout 日志 |
| `["tasks", taskId, "stderr"]` | 后台任务 stderr 日志 |
| `["debug", runId, "trace"]` | 调试 JSON dump |
| `["attachments", sessionId, attachmentId]` | 附件或缓存文件 |

反例：`["message", sessionId, messageId]` 不应再作为 message 存储路径。message/part 是结构化数据，属于 `services/database`。

---

## 三、ContentKind 与读写接口

```typescript
type ContentKind = 'text' | 'bytes' | 'json'
```

| ContentKind | 接口 | 说明 |
|-------------|------|------|
| `text` | `readText` / `writeText` | UTF-8 文本，例如 diff、stdout、stderr |
| `bytes` | `readBytes` / `writeBytes` | 二进制内容，例如未来附件缓存 |
| `json` | `readJson` / `writeJson` / `updateJson` | 调试 dump、迁移备份或轻量 blob |

`json` helper 只处理文件对象中的 JSON blob，不承担 SQL 查询或领域仓储职责。

---

## 四、StorageObject（文件对象）

```typescript
interface StorageObject {
  key: StorageKey
  location: StorageLocation
  contentKind: ContentKind
  sizeBytes?: number
  updatedAt?: number
}
```

storage 不持久化 `StorageObject` 元数据表；它只是文档中的概念，用于说明一个 key 解析后对应一个文件对象。若需要索引、查询、关联和保留策略，调用方应在 database 中维护元数据。

---

## 五、StorageLocation（解析后路径）

```typescript
type StorageLocation = string & { readonly _brand: 'StorageLocation' }
```

PathResolver 负责将 `StorageKey` 解析为 `StorageLocation`：

```
StorageRoot = ~/.local/share/ohbaby/storage
key         = ["snapshot", "patches", "ckpt_1", "patch_1"]
location    = ~/.local/share/ohbaby/storage/snapshot/patches/ckpt_1/patch_1.diff
```

实际扩展名可由调用方通过 key 约定或 `writeText/writeBytes/writeJson` 的 options 指定。PathResolver 必须验证解析结果仍位于 StorageRoot 内。

---

## 六、错误类型

```typescript
class NotFoundError extends Error {
  readonly key: StorageKey
}

class InvalidStorageKeyError extends Error {
  readonly key: StorageKey
  readonly reason: string
}
```

| 错误 | 触发条件 |
|------|----------|
| `NotFoundError` | 读取不存在的文件对象 |
| `InvalidStorageKeyError` | key segment 非法，或解析路径逃逸 storage root |

---

## 七、Lifecycle & Ownership（生命周期与归属）

| 数据 | 创建者 | 内容持有者 | 元数据持有者 | 删除者 |
|------|--------|------------|--------------|--------|
| snapshot patch artifact | snapshot | storage | database 的 `snapshot_patch` 表 | snapshot |
| task stdout/stderr | runtime/tasks | storage | tasks 自己的 task 记录 | runtime/tasks |
| debug JSON dump | 调用方模块 | storage | 调用方模块 | 调用方模块 |

storage 负责“把内容可靠地放到磁盘上”，不负责判断内容何时应该存在、保留多久、是否与某条业务记录一致。

---

## 八、文档自检

- [x] Key、内容格式、路径位置均已定义
- [x] 明确 JSON blob 不等于结构化业务数据仓储
- [x] 与 database 的元数据/内容分工清晰
- [x] 不再出现 session/message/part JSON 存储路径作为推荐用法
