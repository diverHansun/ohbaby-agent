# snapshot/store 模块 goals-duty.md

本文档定义 `snapshot/store` 子模块的设计目标与职责边界。

> 本文档聚焦于 snapshot 模块的**持久化子系统**（store 层）。关于 snapshot 模块整体的 diff/restore/revert 能力，见 `docs/snapshot/goals-duty.md`。

---

## 一、模块定位

**一句话说明**：snapshot/store 是 snapshot 模块的持久化层，负责检查点索引和 patch 元数据的 SQL 存储（via `services/database`），以及 patch artifact 大对象的文件存储（via `services/storage`），为 snapshot 的 diff、restore、revert 能力提供数据支撑。

**两层存储分工**：
- **`services/database`（SQL）**：checkpoint 索引、patch 元数据、关联关系（sessionId/runId/turnId/checkpointId）、查询字段
- **`services/storage`（文件）**：实际 diff artifact（unified diff / binary patch）大对象，路径指针存在 `snapshot_patch.artifact_path`

**如果没有这个模块**：
- snapshot 的检查点数据只存在内存中，进程崩溃后审计链断裂
- restore/revert 时无法找到对应的 patch artifact
- 无法按 session/run/turn 维度查询历史检查点
- diff artifact 文件与元数据分散，清理策略难以实施

---

## 二、Design Goals（设计目标）

### G1: 索引与大对象分离

checkpoint 元数据和 patch 元数据存入 SQLite（支持关系查询），实际 diff artifact 内容存入文件系统（避免 DB 膨胀）。两者通过 `artifact_path` 字段关联。

### G2: 支持按多维度查询检查点

提供以下查询能力，供 snapshot 核心层使用：
- 按 `sessionId` 列出所有检查点
- 按 `sessionId + runId` 过滤检查点
- 按 `checkpointId` 获取对应的 patch 列表

### G3: 保留审计元数据，独立清理大对象

清理策略可以单独删除旧的 artifact 文件（节省磁盘），但 checkpoint 元数据记录（包括时间、文件数量、关联关系）应当保留作为审计历史。`snapshot_patch.artifact_path` 可置为 `null` 表示 artifact 已清理。

### G4: 崩溃安全写入

checkpoint 记录在 Turn 开始前写入（先于任何文件变更），确保崩溃后能识别哪些 Turn 存在未完成的 patch。patch 记录在 Turn 结束后写入。

### G5: 处理 DB 元数据与 artifact 文件的非事务一致性

SQLite 事务无法覆盖文件系统写入。snapshot/store 必须承认并管理这种边界：artifact 文件写入、DB 元数据更新、清理流程都要设计成可重试、可恢复、可清理，而不是假装两者天然原子。

---

## 三、Duties（职责）

### D1: Checkpoint 元数据写入

提供接口在 Turn 开始时创建 checkpoint 记录：
- `createCheckpoint(params)`: 写入 `snapshot_checkpoint` 表
  - `checkpointId`（主键，由 snapshot 核心层生成）
  - `sessionId`、`runId`（可选）、`turnId`（Turn 级边界，MVP 应尽量总是提供）
  - `workdir`
  - `messageCursorBefore`（Turn 开始时的 message 位置书签）
  - `createdAt`
- `updateCheckpointMessageCursor(checkpointId, messageCursorAfter)`: Turn 结束时写入结束 cursor

### D2: Patch 元数据写入

提供接口在 Turn 结束时记录 patch 信息：
- `createPatch(params)`: 写入 `snapshot_patch` 表
  - `patchId`
  - `checkpointId`（关联 checkpoint）
  - `artifactPath`（patch 文件在 storage 中的路径，可为 null）
  - `fileCount`（变更文件数，便于快速过滤空 patch）
  - `createdAt`
- `updatePatchArtifact(patchId, artifactPath)`: artifact finalize 成功后更新最终路径

`artifactPath = null` 的含义必须结合 `fileCount` 判断：`fileCount = 0` 表示无变更、无需 artifact；`fileCount > 0` 表示 artifact 已清理或写入失败，恢复能力不可用。

### D3: Artifact 文件写入

将实际 diff 内容写入 `services/storage`：
- Key 格式：`["snapshot", "patches", checkpointId, patchId]`
- 写入流程：先由 D2 创建 patch 元数据行（`artifact_path = null`），再写 staging artifact，finalize 到稳定 key，最后调用 `updatePatchArtifact()` 更新 `snapshot_patch.artifact_path`
- artifact 格式：unified diff 文本（或 binary patch）

### D4: 检查点查询

提供查询接口：
- `listCheckpoints(sessionId, options?)`: 按 session 列出检查点，支持 runId/turnId 过滤，按 `createdAt` 倒序
- `getCheckpoint(checkpointId)`: 获取单条 checkpoint 记录
- `getPatches(checkpointId)`: 获取 checkpoint 下的所有 patch 元数据
- `listPatchesFromCheckpoint(checkpointId)`: 获取从某 checkpoint 到当前最新状态之间需要反向应用的 patch 链，按 `createdAt` 倒序返回

### D5: Artifact 文件读取

提供 patch artifact 的读取接口：
- `readArtifact(patchId)`: 根据 `artifact_path` 从 storage 读取 diff 内容
- 如果 `artifact_path` 为 null（已清理），返回 `ArtifactNotAvailableError`

### D6: 保留策略与清理

提供可调用的清理接口（由 snapshot 核心层按策略触发）：
- `deleteArtifact(patchId)`: 删除 storage 中的 artifact 文件，将 `artifact_path` 置 null
- `deleteCheckpoint(checkpointId, { cascade? })`: 删除 checkpoint 及其 patch 元数据（可选 cascade 同时删 artifact 文件）
- **不自行触发清理**：清理策略（按 session 生命周期、存储配额、时间窗口）由 snapshot 核心层决定

### D7: Artifact 与元数据的一致性修复

负责提供可恢复的一致性策略：
- artifact 写入使用 staging key，例如 `["snapshot", "staging", patchId]`
- staging 写完后先 finalize 到稳定 key，再在 DB 中登记最终 `artifact_path`
- 如果 artifact finalize 成功但 DB 更新失败，保留 orphan 文件并通过 `cleanupOrphanArtifacts()` 后台清理
- 如果 DB 记录存在但 artifact 缺失，且 `fileCount > 0`，`readArtifact()` 返回 `ArtifactNotAvailableError`，由 snapshot 核心层决定是否重新生成或提示用户
- 如果 `fileCount = 0` 且 `artifactPath = null`，这是合法空 patch，调用方应跳过 artifact 读取
- 写入接口应尽量幂等：重复调用同一个 `patchId` 不应产生多个互相冲突的 artifact

---

## 四、Non-Duties（非职责）

### N1: 不计算 diff / patch 内容

实际的文件差异计算（git diff、shadow copy 对比等）由 snapshot 核心层完成。store 只负责将结果持久化。

### N2: 不执行 restore / revert

将文件恢复到检查点状态的操作由 snapshot 核心层负责。store 只提供数据读取接口。

### N3: 不决定保留策略

哪些 checkpoint 应当清理、保留多少历史，由 snapshot 核心层或用户配置决定。store 只执行清理指令。

### N4: 不感知 sandbox 或 workdir

store 只存储 `workdir` 字符串，不理解其含义（原始目录 vs worktree vs container）。

---

## 五、设计约束与假设

### 约束

1. **依赖 Database 模块**：`snapshot_checkpoint` 和 `snapshot_patch` 表的 Schema 由 `services/database` 统一管理
2. **依赖 Storage 模块**：artifact 文件通过 `services/storage` 写入和读取
3. **artifact 与 DB 非同一事务**：artifact 文件写入和 SQLite metadata 更新不能放进同一个原子事务，必须通过 staging、幂等写入和 orphan cleanup 处理不一致窗口

### 假设

1. `checkpointId` 和 `patchId` 由 snapshot 核心层生成，保证全局唯一
2. 一个 Turn 对应一个 checkpoint；MVP 阶段同一 checkpoint 通常最多对应一个 Turn patch，重复 capture 应保持幂等
3. message cursor 由 message/session 层生成，store 只保存 JSON 书签，不理解 message 内容
4. artifact 文件大小适合文件系统存储（通常是单次 Turn 的文件 diff，不是整个工作区镜像）

---

## 六、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `snapshot`（核心层） | 被依赖 | snapshot 核心层通过 store 接口读写检查点和 patch 数据 |
| `services/database` | 依赖 | 读写 snapshot_checkpoint / snapshot_patch 表 |
| `services/storage` | 依赖 | 读写 patch artifact 文件 |
| `runtime/run-ledger` | 无直接依赖 | 通过 runId 在业务层松散关联，不互相调用 |
| `services/session` | 无直接依赖 | 通过 sessionId 在业务层松散关联 |

---

## 七、数据结构

```typescript
interface SnapshotCheckpoint {
  checkpointId: string
  sessionId: string
  runId?: string
  turnId: string
  workdir: string
  messageCursorBefore?: MessageCursor
  messageCursorAfter?: MessageCursor
  createdAt: number       // Unix timestamp ms
}

interface MessageCursor {
  messageId?: string
  partId?: string
  sequence: number
}

interface SnapshotPatch {
  patchId: string
  checkpointId: string
  artifactPath: string | null  // null = artifact 已清理或写入失败
  fileCount: number
  createdAt: number
}
```

---

## 八、文档自检

- [x] 可以用一句话说明模块存在的意义
- [x] 两层存储分工清晰（SQL 索引 vs 文件 artifact）
- [x] 不执行 diff 计算或 restore，只负责数据读写
- [x] 审计元数据保留策略与 artifact 清理策略解耦
- [x] 明确处理 artifact 文件与 DB 元数据之间的非事务一致性问题
- [x] 所有职责可被测试或验证
