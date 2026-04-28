# snapshot 模块 data-model.md

本文档定义 `snapshot` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### SnapshotCheckpoint

**Turn 级变更基线**。在 Turn 开始前创建，记录当前工作区的基线状态和 message 流的位置。后续 diff / restore 以此为参照点，message 回滚以 cursor 为定位依据。

一个 Turn 对应一个 checkpoint。MVP 阶段，一个 checkpoint 通常对应零个或一个 Turn patch；未来如果引入多次 capture / 多阶段提交，可在不改变 checkpoint 概念的前提下扩展为多个 patch。checkpoint 不存储完整文件快照，只是一个时间点标记和关联索引。

MVP 语义下，`capture(checkpointId)` 对同一个 checkpoint 是幂等的：通常一个 checkpoint 最多产生一个 Turn patch；重复 capture 应返回已有 patch 或按既定策略跳过重复写入，不能产生多个互相冲突的 artifact。

### WorkspaceRef

**工作区引用**。描述 snapshot 这次应作用在哪个文件系统目录。MVP 可直接使用 `workdir` 字符串；文档中使用 `WorkspaceRef` 表达其语义：workdir 可以来自 sandbox lease，也可以来自 session/project 解析结果。snapshot 不持有也不释放 `SandboxLease`。

### MessageCursor

**消息流位置书签**。记录 Turn 开始/结束时 message store 写到了哪里。它不是 message 内容本身，而是一个可用于后续截断或标记回滚的定位信息。snapshot 只保存 cursor；真正的 message 回滚由 message/session 层执行。

### SnapshotPatch

**一次变更的差异记录**。在 Turn 结束后生成，记录从 checkpoint 基线到当前状态的文件差异。patch 元数据存入 SQL，实际 diff 内容（artifact）存入文件系统。

`artifact_path` 可为 null。若 `fileCount = 0`，表示该 Turn 无文件变更，不需要 artifact；若 `fileCount > 0`，表示 artifact 已被清理或写入失败，恢复能力降级但元数据仍保留作为审计历史。

### SnapshotDiff

**两个检查点之间的差异展示**。由 `diff(from, to)` 生成，包含文件级和块级差异信息。这是 UI 展示和 revert 操作的输入数据。

SnapshotDiff 是计算结果（Value Object），不持久化。

### DiffEngine

**文件差异计算引擎**。核心层内部组件，负责实际的文件对比。可基于 git diff 或 shadow copy 实现，对外不暴露。

---

## 二、Entity / Value Object 区分

| 概念 | 类型 | 说明 |
|------|------|------|
| `SnapshotCheckpoint` | Entity | 有身份（checkpointId），持久化到 DB |
| `SnapshotPatch` | Entity | 有身份（patchId），持久化到 DB + storage |
| `SnapshotDiff` | Value Object | diff() 的计算结果，不持久化 |
| `WorkspaceRef` | Value Object | 工作区位置描述，通常包含 workdir |
| `MessageCursor` | Value Object | message store 的位置书签 |
| `ArtifactContent` | Value Object | patch artifact 的实际内容（unified diff 文本） |

---

## 三、Key Data Fields（关键数据字段）

### SnapshotCheckpoint

```typescript
interface SnapshotCheckpoint {
  checkpointId: string      // 全局唯一 ID（由 SnapshotService 生成）
  sessionId: string
  runId?: string
  turnId: string            // Turn 级边界，MVP 应尽量总是提供
  workdir: string           // 检查点对应的工作目录（来自 WorkspaceRef）
  workspaceSource?: 'sandbox' | 'session' | 'project'
  messageCursorBefore?: MessageCursor
  messageCursorAfter?: MessageCursor
  createdAt: number         // Unix timestamp ms
}
```

### MessageCursor

```typescript
interface MessageCursor {
  messageId?: string         // Turn 开始/结束时最后一条稳定 message
  partId?: string            // 可选，定位到 message 内部 part
  sequence: number           // 单调递增位置，便于 truncate / compare
}
```

### SnapshotPatch

```typescript
interface SnapshotPatch {
  patchId: string           // 全局唯一 ID
  checkpointId: string      // 关联的 checkpoint
  artifactPath: string | null  // artifact 在 storage 中的路径；null = 已清理或写入失败
  fileCount: number         // 变更文件数（便于快速过滤空 patch）
  createdAt: number
}
```

### SnapshotDiff

```typescript
interface SnapshotDiff {
  fromCheckpointId: string
  toCheckpointId?: string   // 可选，若省略则 diff 到当前工作区状态
  files: FileDiff[]
  summary: { added: number; modified: number; deleted: number }
}

interface FileDiff {
  path: string              // 相对于 workdir 的路径
  status: 'added' | 'modified' | 'deleted'
  hunks?: DiffHunk[]        // 块级差异（可选，供 UI 渲染）
}
```

---

## 四、Storage Layout（存储布局）

### SQL 表（via services/database）

**snapshot_checkpoint 表**：
| 字段 | 类型 | 说明 |
|------|------|------|
| checkpoint_id | TEXT PK | 主键 |
| session_id | TEXT NOT NULL | 关联 session |
| run_id | TEXT | 可选，关联 run |
| turn_id | TEXT NOT NULL | 关联 turn |
| workdir | TEXT NOT NULL | 工作目录绝对路径 |
| workspace_source | TEXT | workdir 来源：sandbox/session/project |
| message_cursor_before | TEXT | JSON，Turn 开始时 message cursor |
| message_cursor_after | TEXT | JSON，Turn 结束时 message cursor |
| created_at | INTEGER NOT NULL | Unix timestamp ms |

索引：`(session_id, created_at DESC)`、`(session_id, run_id, turn_id)`

**snapshot_patch 表**：
| 字段 | 类型 | 说明 |
|------|------|------|
| patch_id | TEXT PK | 主键 |
| checkpoint_id | TEXT NOT NULL | 关联 checkpoint（FK） |
| artifact_path | TEXT | storage 中的路径；null = 已清理 |
| file_count | INTEGER NOT NULL | 变更文件数 |
| created_at | INTEGER NOT NULL | Unix timestamp ms |

索引：`(checkpoint_id)`

### 文件 artifact（via services/storage）

- 稳定 key：`["snapshot", "patches", checkpointId, patchId]`
- staging key：`["snapshot", "staging", patchId]`
- 内容格式：unified diff 文本（或 binary patch）

---

## 五、Lifecycle & Ownership（生命周期与归属）

```
Turn 开始前（run worker / hooks 调用）
  → snapshotService.track({ sessionId, runId, turnId, workdir, messageCursorBefore })
  → 创建 SnapshotCheckpoint（写入 DB）
  → DiffEngine 记录基线状态

Turn 执行中
  → agent 通过工具修改文件

Turn 结束后（run worker / hooks 调用）
  → snapshotService.capture({ checkpointId, messageCursorAfter })
  → DiffEngine 计算差异
  → SnapshotPatch 先写入 DB（artifact_path = null）
  → 若有变更：
    → artifact 写入 storage（staging → finalize）
    → 更新 SnapshotPatch.artifact_path
  → 若无变更：
    → 保留 SnapshotPatch（fileCount = 0，artifact_path = null）

查询 / 展示
  → snapshotService.diff(fromCheckpointId, toCheckpointId?)
  → 返回 SnapshotDiff（Value Object）

恢复
  → snapshotService.restore(checkpointId)
  → 读取 patch artifact，反向应用

清理（由核心层按策略触发）
  → store.deleteArtifact(patchId)  → artifact_path 置 null
  → store.deleteCheckpoint(checkpointId, { cascade })  → 删除元数据 + 可选删 artifact
```

**所有权规则**：
- `SnapshotCheckpoint` / `SnapshotPatch` 的所有权归 `SnapshotStore`（DB 持久化）
- artifact 文件的所有权归 `services/storage`，store 层通过 key 管理
- `SnapshotDiff` 是临时计算结果，不持久化，调用方按需使用
- `MessageCursor` 由 message/session 层提供，snapshot 只保存书签，不改写 message 内容
- `checkpointId` / `patchId` 由 `SnapshotService` 生成，保证全局唯一
