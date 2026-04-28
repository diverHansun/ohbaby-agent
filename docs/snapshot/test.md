# snapshot 模块 test.md

本文档说明如何验证 `snapshot` 模块在协作环境中的正确性。

---

## 一、Test Scope（测试范围）

**覆盖**：
- track() / capture() 的完整流程：checkpoint 创建 → diff 计算 → patch 生成 → artifact 持久化
- Turn 级 message cursor 的记录：track 保存 before cursor，capture 保存 after cursor
- restore() 的回滚正确性：patch 反向应用后工作区状态与 checkpoint 基线一致
- restore() 的并发检查：有 active 写入时返回 ConflictError
- diff() 的查询正确性：返回的 SnapshotDiff 与实际文件变更一致
- listCheckpoints() 的查询与过滤：按 sessionId / runId 过滤，按 createdAt 倒序
- artifact 不可用时的错误处理：artifactPath = null 时 readArtifact 返回 ArtifactNotAvailableError
- 空 patch 场景：Turn 无文件变更时仍创建 patch 记录（fileCount = 0）
- store 层的 staging/finalize 流程：artifact 写入的两步提交
- orphan cleanup：staging 残留文件的清理

**不覆盖**：
- DiffEngine 的具体 diff 算法实现（属于 DiffEngine 内部单元测试）
- services/database 的 SQL 执行细节（属于 database 模块测试）
- services/storage 的文件 I/O 细节（属于 storage 模块测试）
- sandbox 的路径验证逻辑（属于 sandbox 模块测试）
- policy / permission 的权限决策（不由 snapshot 负责）

---

## 二、Critical Scenarios（关键场景）

### 场景组 1：track() + capture() 完整流程

| 场景 | 预期结果 |
|------|---------|
| track() 成功 | checkpoint 写入 DB，checkpointId 返回，messageCursorBefore 被保存 |
| capture() 有文件变更 | patch 写入 DB（fileCount > 0），artifact 写入 storage，messageCursorAfter 被保存 |
| capture() 无文件变更 | patch 写入 DB（fileCount = 0，artifactPath = null），不写 artifact |
| track() DB 写入失败 | 抛错，不返回 checkpointId，Turn 不应继续 |
| capture() artifact 写入失败 | patch 写入 DB（fileCount > 0，artifactPath = null），不阻断审计链 |
| capture() 重复调用同一 checkpoint | 返回已有 patch 或跳过重复写入，cursor 语义保持一致 |

### 场景组 2：restore()

| 场景 | 预期结果 |
|------|---------|
| restore() 到有效 checkpoint | 工作区文件恢复到 checkpoint 基线状态 |
| restore() 时有 active Run 写入 | 上层 active writer 检查返回 ConflictError，不修改文件 |
| restore() 时有 workspace-rw Task 写入 | 上层 active writer 检查返回 ConflictError，不修改文件 |
| restore() 时 fileCount > 0 且 artifact 不可用 | 返回 ArtifactNotAvailableError |
| restore() 遇到 fileCount = 0 的空 patch | 跳过该 patch，不报错 |
| restore() 后审计元数据 | checkpoint / patch 记录保留，不删除，并返回 messageCursorBefore 供上层消息回滚 |

### 场景组 3：diff() 查询

| 场景 | 预期结果 |
|------|---------|
| diff(from, to) 两个有效 checkpoint | 返回 SnapshotDiff，files 列表正确 |
| diff(from) 省略 to | diff 到当前工作区状态 |
| diff() 无变更 | 返回空 files 列表，summary 全为 0 |

### 场景组 4：store 层一致性

| 场景 | 预期结果 |
|------|---------|
| artifact staging 成功 + finalize 成功 + DB 更新成功 | 正常路径，artifactPath 指向稳定 key |
| artifact staging 成功 + finalize 失败 | staging 文件残留，orphan cleanup 后清理 |
| artifact finalize 成功 + DB 更新失败 | orphan artifact 存在，cleanup 后清理 |
| 重复 capture() 同一 checkpointId | 返回已有 patch 或跳过重复写入，不产生冲突 artifact |
| orphan cleanup 执行 | staging 残留文件被删除，DB 中无对应记录的 artifact 被删除 |

### 场景组 5：listCheckpoints() 查询

| 场景 | 预期结果 |
|------|---------|
| listCheckpoints(sessionId) | 返回该 session 所有 checkpoint，按 createdAt 倒序 |
| listCheckpoints(sessionId, { runId }) | 只返回该 run 的 checkpoint |
| listCheckpoints() 空结果 | 返回空数组 |

---

## 三、Integration Points（集成点测试）

### 集成点 1：snapshot + 真实文件系统（集成测试）

**验证重点**：track() → 修改文件 → capture() → restore() 的端到端正确性

**方式**：使用临时目录，创建真实文件，修改后 capture()，再 restore() 验证文件内容恢复；使用 fake message cursor 验证 checkpoint 中 before/after cursor 的保存和读取

**关注**：
- 多文件变更（新增、修改、删除）的 diff 和 restore 正确性
- 二进制文件的处理（是否正确标记为 binary patch）
- 空目录的处理

### 集成点 2：snapshot + 真实 SQLite（集成测试）

**验证重点**：checkpoint / patch 元数据的 DB 读写正确性，包括查询过滤和排序

**方式**：使用 in-memory SQLite，不 mock database 模块

**关注**：
- listCheckpoints() 的排序和过滤
- getPatches(checkpointId) 的关联查询
- 崩溃恢复场景：有 checkpoint 无 patch 的识别
- messageCursorBefore / messageCursorAfter 的 JSON 持久化与读取

### 集成点 3：snapshot + services/storage（集成测试）

**验证重点**：artifact 的 staging → finalize → read → delete 流程

**方式**：使用真实 storage（tmpdir），不 mock

**关注**：
- staging key 和稳定 key 的正确切换
- readArtifact() 在 artifact 存在和不存在时的行为
- deleteArtifact() 后 artifactPath 置 null

---

## 四、Verification Strategy（验证策略）

### 主策略：单元测试（unit）+ 文件系统集成测试（integration）

**单元测试覆盖**（mock store 层和 DiffEngine）：
- SnapshotService 的 track / capture / restore / revert 流程编排
- active writer 检查结果的处理（restore 前由上层或注入的 checker 提供 active Run/Task 状态）
- 空 patch 场景的处理
- artifact 不可用时的错误传播
- message cursor 的保存与返回

**Mock 范围**（unit 层）：
- `SnapshotStore` → fake store（记录调用，可配置成功/失败/artifact 不可用）
- `DiffEngine` → fake engine（返回预设 diff 结果，可配置空变更）
- `ActiveWriterChecker` 或等价上层检查器 → fake checker（返回有/无 active writer）
- 不 mock SnapshotService 本身（被测对象）

**集成测试覆盖**（真实文件系统 + 真实 SQLite + 真实 storage）：
- 端到端 track → capture → restore 流程
- store 层的 staging/finalize/orphan cleanup
- 多 Turn 场景：连续 track/capture 后 restore 到中间 checkpoint

**不 mock**（integration 层）：SQLite（in-memory）、services/storage（tmpdir）、文件系统

### 关注点：restore 的正确性验证

restore 测试必须验证文件内容（不只是文件存在性）。对于每个被修改的文件，断言 restore 后的内容与 checkpoint 基线完全一致。使用 file hash 或逐字节比较。

### 关注点：多 Turn 回滚顺序

多个 Turn 的 patch 必须按正确顺序反向应用。测试应构造 3+ 个连续 Turn（每个 Turn 修改不同文件或同一文件的不同部分），restore 到第一个 checkpoint 后验证所有变更都被正确回滚。

### 关注点：store 层的幂等性

重复调用 capture() 同一 checkpointId 不应产生冲突或重复 artifact。MVP 推荐行为是返回已有 patch 或跳过重复写入；测试应固定这一语义，而不是让实现自由选择。
