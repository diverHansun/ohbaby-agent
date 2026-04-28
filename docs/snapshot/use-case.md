# snapshot 模块 use-case.md

本文档描述 `snapshot` 模块内部如何围绕职责完成关键业务动作。

---

## 一、Use Case Overview（用例概览）

| # | 用例 | 触发来源 | 职责映射 |
|---|------|---------|---------|
| UC1 | Track Baseline at Turn Start | run worker / hooks | 检查点创建、文件基线记录、message cursor 保存 |
| UC2 | Capture Changes at Turn End | run worker / hooks | diff 计算、patch 生成、artifact 持久化、结束 cursor 更新 |
| UC3 | Restore to Checkpoint | session / revert 操作 | active writer 检查、patch 读取、文件反向应用、为消息回滚提供 cursor |
| UC4 | Query and Display Diff | UI / agent | 检查点查询、差异展示 |

---

## 二、Main Flow Description（主流程描述）

### UC1：Track Baseline at Turn Start

在 Turn 开始前记录工作区基线，为后续 diff 提供参照点。

```
输入：track({ sessionId, runId, turnId, workdir, messageCursorBefore })
  ↓
1. 标准化输入
   → workdir 由调用方提供，可来自 sandbox lease，也可来自 session/project
   → messageCursorBefore 由 message/session 层提供
  ↓
2. 生成 checkpointId
  ↓
3. 持久化 checkpoint 元数据
   → store.createCheckpoint({ checkpointId, sessionId, runId, turnId, workdir, messageCursorBefore })
   → 写入 snapshot_checkpoint 表
  ↓
4. 记录文件基线
   → DiffEngine.recordBaseline(workdir)
   → 实现策略：git index snapshot / shadow copy / file hash map
  ↓
输出：checkpointId
```

**注意**：checkpoint 记录在 Turn 开始前写入（先于任何文件变更和后续消息追加），确保崩溃后能识别哪些 Turn 存在未完成的 patch，并能知道消息应回滚到哪个 cursor。

---

### UC2：Capture Changes at Turn End

Turn 结束后，计算文件差异并生成 patch。

```
输入：capture({ checkpointId, messageCursorAfter })
  ↓
1. 计算差异
   → DiffEngine.computeDiff(baseline, currentWorkdir)
   → 生成 unified diff 内容 + fileCount
  ↓
2. 判断是否有变更
   ├── fileCount = 0 → 执行步骤 3 后直接输出（空 patch）
   └── fileCount > 0 → 继续
  ↓
3. 先持久化 patch 元数据
   → store.createPatch({ patchId, checkpointId, artifactPath: null, fileCount })
  ↓
4. 持久化 artifact（仅 fileCount > 0）
   → store.writeArtifact(patchId, diffContent)
     → staging key 写入 services/storage
     → finalize 到稳定 key
     → 返回 artifactPath
  ↓
5. 更新 patch artifact 指针
   → store.updatePatchArtifact(patchId, artifactPath)
  ↓
6. 更新 checkpoint 的结束 cursor
   → store.updateCheckpointMessageCursor(checkpointId, messageCursorAfter)
  ↓
输出：SnapshotPatch
```

空 patch（`fileCount = 0`）仍写入 metadata，但不写 artifact，`artifactPath = null` 是合法状态。

---

### UC3：Restore to Checkpoint

恢复工作区到某个检查点的基线状态。

```
输入：restore(checkpointId)
  ↓
1. 并发写入检查
   → 上层 revert 编排查询 run-manager，确认当前 session 无 active Run
   → 查询 tasks，确认当前 session 无 workspace-rw Task
   → 若有并发写入 → 返回 ConflictError（不强行覆盖）
  ↓
2. 确定回滚范围
   → 获取从 checkpointId 到当前最新 checkpoint 之间的所有 patch
   → 按 createdAt 倒序排列（最新的先回滚）
  ↓
3. 逐个回滚 patch
   → 对每个 patch：
     → 若 fileCount = 0 且 artifactPath = null → 空 patch，跳过
     → 若 fileCount > 0 且 artifactPath = null → ArtifactNotAvailableError
     → store.readArtifact(patchId)
     → DiffEngine.applyReverse(workdir, diffContent)
  ↓
4. 保留审计记录
   → 回滚操作本身不删除 checkpoint / patch 元数据
   → 可选：创建一个新的 checkpoint 记录回滚后的状态
  ↓
5. 返回 message cursor 信息
   → snapshot 返回 checkpoint.messageCursorBefore
   → 上层编排调用 message/session 层执行 truncate / mark reverted
  ↓
输出：文件恢复完成；消息回滚由上层继续执行
```

---

### UC4：Query and Display Diff

查询检查点列表和两个检查点之间的差异。

```
查询检查点列表：
  → snapshotService.listCheckpoints(sessionId, { runId? })
  → store.listCheckpoints(sessionId, options)
  → 返回 SnapshotCheckpoint[]

查询差异：
  → snapshotService.diff(fromCheckpointId, toCheckpointId?)
  → 读取相关 patch artifact
  → 组合或重新计算差异
  → 返回 SnapshotDiff { files, summary }
```

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|------|------|------|
| 决定何时 track / capture | run worker / hooks | snapshot 不自行决定 Turn 边界 |
| message cursor 读取 | message/session 层 | snapshot 只保存 cursor，不读取或改写 message 内容 |
| 文件差异计算 | snapshot（DiffEngine） | 核心职责 |
| artifact 持久化（staging/finalize） | snapshot/store | 核心层不感知 staging 细节 |
| 并发写入检查 | 上层 revert 编排 + run-manager/tasks | snapshot 不使用 SandboxLease 作为权威锁 |
| 权限决策（能否 restore） | core/policy + core/permission | snapshot 不做权限判断 |
| workdir 提供 | run worker / session/project / sandbox | snapshot 只使用 workdir，不创建执行环境，不持有 SandboxLease |
| 消息回滚执行 | message/session 层 + 上层编排 | snapshot 提供 cursor，不执行 truncate |
| 清理策略决定 | 核心层 / 用户配置 | store 只执行清理指令 |

---

## 四、Failure & Decision Points（失败点与决策点）

### 决策点 1：restore 时发现并发写入

**策略**：返回 ConflictError，不强行覆盖文件。

**理由**：restore 会修改工作区文件，如果有 active Run / workspace-rw Task 正在写入，强行覆盖可能导致数据损坏或不一致。调用方应先取消 active Run / Task，再执行 restore。这个判断来自 run-manager/tasks，而不是 SandboxLease。

### 决策点 2：capture 时无文件变更

**策略**：仍创建 SnapshotPatch（fileCount = 0，artifactPath = null），不写 artifact，但不跳过元数据。

**理由**：保留完整的 Turn 审计链。即使某个 Turn 没有文件变更，也应有记录表明"这个 Turn 被检查过"。

### 失败点 1：artifact 写入失败

**场景**：storage 写入失败（磁盘满、权限问题）

**预期行为**：patch 元数据已写入或继续写入 DB（fileCount > 0，artifactPath = null），并尽量写入 `messageCursorAfter`，记录日志。后续 restore/readArtifact() 返回 ArtifactNotAvailableError。核心层可选择重新生成 artifact（如果基线数据仍可用）。

### 失败点 2：restore 时 artifact 不可用

**场景**：artifact 已被清理或写入失败（fileCount > 0，artifactPath = null）

**预期行为**：返回 ArtifactNotAvailableError。核心层向调用方提示"该检查点的变更数据已清理，无法恢复"。不静默跳过。

### 失败点 3：track() 的 DB 写入失败

**场景**：SQLite 写入失败

**预期行为**：track() 抛错。Turn 不应在没有 checkpoint 的情况下继续执行（否则崩溃后审计链断裂）。run worker / hooks 应将此视为 Turn 启动失败。
