# storage 模块 test.md

本文档定义 `services/storage` 的测试范围和验证策略。测试目标是证明文件对象读写、路径安全和单文件原子性可信。

---

## 一、Test Scope（测试范围）

### 覆盖

| 职责 | 测试重点 |
|------|----------|
| Key 到路径映射 | 合法 key 解析到 storage root 内；非法 segment 被拒绝 |
| text/bytes/json 读写 | 内容原样保存，JSON helper 可正确序列化和反序列化 |
| 原子写入 | 写入失败不暴露半截目标文件 |
| 读写锁 | 多读可并行，写操作独占 |
| list/exists/remove | 前缀列举、存在性判断和删除语义正确 |

### 不覆盖

- session/message/part 的结构化读写（database + 对应业务模块测试）
- snapshot patch 的业务一致性（snapshot 测试）
- task 日志何时写入、何时清理（runtime/tasks 测试）
- 云存储、加密、备份恢复（非 MVP）

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|----------|
| `writeText()` 后 `readText()` | 返回完全一致的 UTF-8 字符串 |
| `writeBytes()` 后 `readBytes()` | 返回完全一致的 bytes |
| `writeJson()` 后 `readJson<T>()` | 类型和值一致，文件保持可读 JSON |
| `updateJson()` 修改一个字段 | 返回更新后的对象，文件内容完整 |
| 读取不存在对象 | 抛出 `NotFoundError` |
| key segment 包含 `..` | 抛出 `InvalidStorageKeyError` |
| key segment 包含 `/` 或 `\` | 抛出 `InvalidStorageKeyError` |
| 写入过程中底层 fs 失败 | 目标文件保持旧内容或不存在，不出现半截内容 |
| `list(["snapshot"])` | 只返回该前缀下对象的 key |
| `remove()` 不存在对象 | 幂等，不抛错 |

---

## 三、Integration Points（集成点）

### 与 snapshot

使用临时 storage root 写入 diff artifact，断言：
- storage 可读回 diff 内容
- 返回 key 可作为 database 中 `snapshot_patch.artifact_path` 的稳定指针
- DB 写入失败时，snapshot 可调用 `remove(key)` 做补偿清理

### 与 runtime/tasks

写入 stdout/stderr 日志，断言：
- 长文本不会被 JSON helper 误解析
- 多次写入同一 key 语义明确（覆盖或由调用方选择新 key）

---

## 四、Verification Strategy（验证策略）

- 使用真实临时文件系统，不 mock `fs`
- 每个测试用例使用独立 storage root
- 并发测试通过多个 Promise 同时读写同一 key 验证锁语义
- 路径安全测试必须覆盖 `..`、路径分隔符、空 segment 和 unicode 文件名

---

## 五、文档自检

- [x] 测试范围匹配文件对象存储定位
- [x] 不再要求验证 session/message JSON 文件
- [x] 覆盖 text / bytes / json 三类接口
- [x] 覆盖路径逃逸和原子写入风险
