# storage 模块 goals-duty.md

本文档定义 `storage` 模块的设计目标与职责边界。

> **定位说明**：ohbaby-agent 引入 `services/database`（SQLite/Drizzle）作为结构化数据的存储层后，`services/storage` 的职责范围已收窄。`storage` 模块**不再是所有持久化数据的通用底层基础设施**，而是专门面向文件对象存储：大对象、二进制数据、patch artifact、任务输出日志、调试 JSON 等场景。结构化数据（session、message、part、run_ledger、checkpoint 索引等）已迁移至 `services/database`。

---

## 一、模块定位

**一句话说明**：storage 模块提供统一的文件对象存储抽象层，将 Key 数组映射到文件系统路径，支持并发安全的读写操作，负责管理无需 SQL 查询的大对象、artifact 文件和配置 blob。

**如果没有这个模块**：
- snapshot 的 patch artifact、task 的输出日志需要各自实现文件 I/O 逻辑
- 并发读写大对象时数据可能损坏或不一致
- 文件路径管理分散，难以统一迁移或扩展
- 跨平台路径处理需要在多处重复实现

**适用场景（相比 services/database）**：
- **用 storage**：patch diff 文件、task stdout/stderr 日志、附件、调试 JSON dump、迁移兼容备份
- **用 database**：session 元数据、message 索引、run 状态账本、scheduler job、snapshot checkpoint 索引

---

## 二、Design Goals（设计目标）

### G1: 统一文件对象存储抽象

提供简洁一致的 Key-Value 风格 API，隐藏底层文件系统细节。调用方只需关心 Key 数组（如 `["snapshot", "patches", checkpointId, patchId]`），无需关心具体路径拼接、目录创建和跨平台差异。**不适用于需要 SQL 查询、索引、外键约束的结构化数据**——这类数据应使用 `services/database`。

### G2: 并发安全

通过读写锁机制保证并发场景下的数据一致性：
- 多个读操作可以并行执行
- 写操作独占访问
- 读写操作互斥

### G3: 原子性更新

提供单对象写入的原子性保障，避免写入中途被读取到半截内容。对于 JSON dump 这类小对象，可保留 `updateJson()` 或等价能力；对于 patch artifact、日志文件这类文本/二进制对象，优先使用显式的写入接口。

### G4: 跨平台兼容

遵循平台数据目录约定，在不同操作系统上自动选择合适的存储路径：
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ohbaby/`
- macOS: `~/Library/Application Support/ohbaby/`
- Windows: `%LOCALAPPDATA%\ohbaby\`

### G5: 简单可靠

API 数量保持最小化，遵循 KISS 原则。每个操作的语义明确，错误处理策略一致。

### G6: 可调试性

对文本 artifact 和调试 JSON 保持人类可读；对二进制 artifact 保持字节级原样保存。storage 不强制所有对象都是 JSON，也不把文件内容解释成业务结构。

---

## 三、Duties（职责）

### D1: Key 到路径的映射

将 Key 数组映射到文件系统路径：
- `["snapshot", "patches", checkpointId, patchId]` → `storage/snapshot/patches/{checkpointId}/{patchId}.diff`
- `["tasks", taskId, "stdout"]` → `storage/tasks/{taskId}/stdout.log`
- 根据写入接口或可选 metadata 决定扩展名 / content type，不默认假设 `.json`
- 处理路径分隔符的跨平台差异

### D2: 基础 CRUD 操作

提供核心的数据操作接口：
- `readText(key)`: 读取 UTF-8 文本，文件不存在时抛出 NotFoundError
- `writeText(key, content)`: 写入 UTF-8 文本，自动创建目录
- `readBytes(key)`: 读取二进制内容
- `writeBytes(key, content)`: 写入二进制内容
- `readJson<T>(key)` / `writeJson<T>(key, content)`: 面向调试 dump、迁移备份等 JSON blob 的便捷接口
- `updateJson<T>(key, fn)`: 原子更新单个 JSON blob；不用于 message/part/session 等结构化数据
- `remove(key)`: 删除文件，不存在时静默忽略
- `list(prefix)`: 列举指定前缀下的所有 Key

### D3: 存在性检查

提供 `exists(key)` 接口，检查指定 Key 是否存在，避免调用方需要通过 try-catch 判断。

### D4: 读写锁管理

维护文件级别的读写锁：
- 支持多读单写的并发模式
- 使用 Disposable 模式自动释放锁
- 写者优先策略，防止写者饥饿

### D5: 目录自动创建

写入操作时自动创建必要的父目录，调用方无需预先创建目录结构。

### D6: 内容格式处理

按对象类型选择合适的读写方式：
- 文本 artifact 使用 UTF-8 文本读写，例如 unified diff、stdout/stderr 日志
- 二进制 artifact 使用 bytes 读写，例如未来的二进制 patch、附件缓存
- JSON blob 使用 JSON helper，并保持 2 空格缩进，便于人工检查
- storage 不解析 message、part、run、checkpoint 等结构化领域模型

### D7: 基础路径管理

管理存储根目录的确定逻辑：
- 遵循 XDG 规范确定基础路径
- 支持环境变量覆盖
- 应用启动时确保目录存在

---

## 四、Non-Duties（非职责）

### N1: 不负责结构化数据存储

Session、Message、Part、run_ledger 等结构化数据由 `services/database`（SQLite）管理。storage 模块只负责不需要 SQL 查询的文件对象和大对象。

### N2: 不负责事件广播

数据变更事件的发布由上层模块负责。storage 模块不发布任何事件，也不把 artifact 写入解释成业务事件。

### N3: 不维护内存缓存

每次读取都从文件系统获取最新数据，不在内存中缓存。缓存策略由上层模块根据需要自行实现。

### N4: 不负责数据迁移

数据格式版本管理和迁移逻辑不在 MVP 范围内。如需迁移，将在后续版本中作为独立功能添加。

### N5: 不负责备份和恢复

数据备份策略不在当前模块职责范围内，可在后续版本中作为独立功能添加。

### N6: 不负责加密

数据加密存储不在 MVP 范围内。如需加密，将通过存储适配器扩展实现。

### N7: 不支持事务

多文件的事务性操作不在当前设计范围内。单文件写入通过临时文件 + rename 保证原子性；JSON blob 的单对象更新通过 `updateJson()` 保证读改写期间的文件级互斥。

### N8: 不负责云存储

云存储（S3/R2）适配不在 MVP 范围内，保留接口扩展能力。

---

## 五、设计约束与假设

### 约束

1. **单进程写入假设**：同一时刻只有一个进程写入同一文件。多进程并发写入场景不在支持范围内。
2. **内容格式约束**：调用方必须选择明确的 text / bytes / json 写入接口，storage 不自动推断业务格式。
3. **文件系统依赖**：底层依赖 Node.js 的 fs 模块。
4. **Key 格式约束**：Key 数组元素必须是合法的文件/目录名，不包含路径分隔符。

### 假设

1. 本地文件系统支持同目录 `rename` 的原子替换语义（写入完成前不会暴露半截目标文件）
2. 存储设备有足够空间
3. 用户对存储目录有读写权限

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `services/database` | 并存互补 | database 负责结构化数据，storage 负责文件对象；snapshot_patch 表在 database 中存路径指针，实际文件由 storage 管理 |
| `snapshot` | 被依赖 | snapshot 将 patch artifact 写入 storage（路径由 database 中的 snapshot_patch 表指向） |
| `runtime/tasks` | 被依赖 | 后台任务将 stdout/stderr 输出日志写入 storage |
| Bus | 无关 | Storage 不发布事件，事件由上层模块负责 |
| Policy | 无关 | 无直接关系 |
| Permission | 无关 | 无直接关系 |

---

## 七、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 与 services/database 的职责边界明确（文件对象 vs 结构化数据）
- [x] 适用/不适用场景有示例说明
- [x] 可以清楚回答"这个模块不该做什么"
- [x] 不存在职责与其他模块明显重叠的风险
- [x] 所有职责可被测试或验证
- [x] 设计目标服务于 KISS 和 YAGNI 原则
- [x] 并发控制策略明确
- [x] 错误处理策略一致（NotFoundError）
