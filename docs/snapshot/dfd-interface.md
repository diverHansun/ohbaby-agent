# snapshot 模块 dfd-interface.md

本文档描述 `snapshot` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

snapshot 是平台级基础设施模块，与以下模块发生数据交换：

| 方向 | 外部模块 | 交互方式 |
|------|---------|---------|
| 被调用 | `runtime/hooks` / run worker | Turn 前后调用 track() / capture() |
| 被调用 | session / revert 操作 | 调用 restore() / revert() 恢复文件状态 |
| 被调用 | UI / stream-bridge | 调用 diff() / listCheckpoints() 展示变更 |
| 接收 | run worker / session/project | 接收 `WorkspaceRef` / `workdir`；workdir 可来自 sandbox，也可来自 session/project |
| 协作 | message/session | 记录 message cursor；真正的 message 回滚由 message/session 层执行 |
| 依赖 | `services/database` | checkpoint / patch 元数据的 SQL 读写 |
| 依赖 | `services/storage` | patch artifact 文件的读写 |

**讨论范围**：本文档关注 SnapshotService 的公共接口和主要数据流。不涉及 DiffEngine 的内部实现或 store 层的 staging/finalize 细节。

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Turn 开始 → 记录基线检查点

```
run worker / hooks（Turn 开始前）
  → 从 message/session 层读取 messageCursorBefore
  → 从 sandbox lease 或 session/project 取得 workdir
  → snapshotService.track({ sessionId, runId, turnId, workdir, messageCursorBefore })
  ↓
SnapshotService 生成 checkpointId
  ↓
store.createCheckpoint({ checkpointId, sessionId, runId, turnId, workdir, messageCursorBefore })
  → 写入 snapshot_checkpoint 表
  ↓
DiffEngine.recordBaseline(workdir)
  → 记录当前文件状态（git index / shadow copy / file hash）
  ↓
输出：checkpointId（供 Turn 结束时使用）
```

### 流程 2：Turn 结束 → 生成 patch

```
run worker / hooks（Turn 结束后）
  → 从 message/session 层读取 messageCursorAfter
  → snapshotService.capture({ checkpointId, messageCursorAfter })
  ↓
DiffEngine.computeDiff(baseline, currentState)
  → 生成 unified diff 内容
  ↓
若有变更（fileCount > 0）：
  → store.createPatch({ patchId, checkpointId, artifactPath: null, fileCount })
    → 先写入 snapshot_patch 表，保留审计元数据
  → store.writeArtifact(patchId, diffContent)
    → staging key 写入 → finalize 到稳定 key
  → store.updatePatchArtifact(patchId, artifactPath)
    → 更新 snapshot_patch.artifact_path
  ↓
若无变更（fileCount = 0）：
  → store.createPatch({ patchId, checkpointId, artifactPath: null, fileCount: 0 })
  ↓
输出：SnapshotPatch
```

### 流程 3：查询检查点与差异

```
UI / session / agent
  → snapshotService.listCheckpoints(sessionId, { runId?, turnId? })
  → store.listCheckpoints(sessionId, options)
  → 返回 SnapshotCheckpoint[]（按 createdAt 倒序）

UI / session
  → snapshotService.diff(fromCheckpointId, toCheckpointId?)
  → 读取 patch artifact（store.readArtifact）
  → 计算或组合差异
  → 返回 SnapshotDiff { files, summary }
```

### 流程 4：恢复到检查点

```
session / revert 操作
  → snapshotService.restore(checkpointId)
  ↓
1. 确认无并发写入
   → 由上层 revert 编排查询 run-manager：当前 session 无 active Run
   → 查询 tasks：当前 session 无 workspace-rw Task
   → 若有 → 返回 ConflictError
  ↓
2. 读取 patch 链
   → store.listPatchesFromCheckpoint(checkpointId) → SnapshotPatch[]
   → 按 createdAt 倒序排列（最新的先回滚）
  ↓
3. 逐个读取 artifact 并反向应用
   → store.readArtifact(patchId) → diff content
   → 若 fileCount = 0 且 artifactPath = null → 空 patch，跳过
   → 若 fileCount > 0 且 artifactPath = null → ArtifactNotAvailableError
   → DiffEngine.applyReverse(workdir, diffContent)
  ↓
4. 验证恢复结果
   → 可选：DiffEngine 验证 workdir 状态与 checkpoint 基线一致
  ↓
5. 消息回滚（由上层编排，不由 snapshot 直接执行）
   → 上层读取 checkpoint.messageCursorBefore
   → 调用 message/session 层 truncate / mark reverted
  ↓
输出：文件恢复完成；上层可继续完成消息回滚；审计元数据保留
```

### 流程 5：清理旧 artifact

```
核心层按策略触发（session 生命周期 / 存储配额 / 时间窗口）
  → store.deleteArtifact(patchId)
    → 删除 storage 中的 artifact 文件
    → snapshot_patch.artifact_path 置 null
  ↓
或：
  → store.deleteCheckpoint(checkpointId, { cascade: true })
    → 删除 checkpoint 元数据 + 关联 patch 元数据 + artifact 文件
```

---

## 三、Interface Definition（接口定义）

### SnapshotService 公共接口

**`track(params)`**
- 输入：`{ sessionId, runId?, turnId, workdir, workspaceSource?, messageCursorBefore? }`
- 输出：`checkpointId`
- 异步：是（DB 写入 + 基线记录）
- 时机：Turn 开始前，先于任何文件变更

**`capture(params)`**
- 输入：`{ checkpointId, messageCursorAfter? }`
- 输出：`SnapshotPatch`
- 异步：是（diff 计算 + artifact 写入 + DB 写入）
- 时机：Turn 结束后
- 幂等：同一 checkpoint 已存在 patch 时，返回已有 patch 或按既定策略跳过重复写入，不创建冲突 artifact

**`diff(fromCheckpointId, toCheckpointId?)`**
- 输入：起始 checkpoint，可选终止 checkpoint（省略则 diff 到当前工作区）
- 输出：`SnapshotDiff`
- 异步：是（可能需要读取 artifact）

**`restore(checkpointId)`**
- 输入：`checkpointId`
- 输出：void（成功）或 ConflictError / ArtifactNotAvailableError
- 异步：是
- 前置条件：上层已确认无 active Run / workspace-rw Task 正在写入同一 workdir
- 说明：只恢复文件状态；消息回滚由上层根据 checkpoint 中的 message cursor 调用 message/session 层完成

**`revert(patches[])`**
- 输入：要回滚的 patch 列表（按顺序）
- 输出：void
- 异步：是

**`listCheckpoints(sessionId, options?)`**
- 输入：sessionId，可选 runId / turnId 过滤
- 输出：`SnapshotCheckpoint[]`（按 createdAt 倒序）

**`getCheckpoint(checkpointId)`**
- 输出：`SnapshotCheckpoint | undefined`

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 创建方 | 所有者 | 责任边界 |
|------|-------|-------|---------|
| `SnapshotCheckpoint` | snapshotService.track() | store 层（DB） | 核心层决定创建时机，store 负责持久化 |
| `SnapshotPatch` | snapshotService.capture() | store 层（DB） | 核心层决定创建时机和内容，store 负责持久化 |
| patch artifact 文件 | store.writeArtifact() | services/storage | store 层管理 key 和生命周期 |
| `SnapshotDiff` | snapshotService.diff() | 调用方（临时） | 计算结果，不持久化 |
| `checkpointId` / `patchId` | SnapshotService | SnapshotService 生成 | 保证全局唯一 |
| `workdir` / `WorkspaceRef` | run worker / session/project | 调用方 | snapshot 只使用，不决定 workdir 来源；sandbox 可作为来源之一但不是必需依赖 |
| `MessageCursor` | message/session 层 | message/session 层 | snapshot 只保存 cursor，不直接改写 message |
| 清理策略 | 核心层 / 用户配置 | 核心层 | store 只执行清理指令，不自行触发 |
