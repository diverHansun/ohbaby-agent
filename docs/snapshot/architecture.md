# snapshot 模块 architecture.md

本文档描述 `snapshot` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

snapshot 模块围绕两层分工展开：**核心层**（diff/restore/revert 能力 + 检查点管理）和 **store 层**（持久化子系统）。

```
消费方（run worker / hooks / session / UI）
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ SnapshotService（核心层）                            │
│                                                     │
│ - track()：在 Turn 开始前记录文件基线 + message cursor │
│ - diff()：生成两个检查点之间的文件差异               │
│ - restore()：恢复到某个检查点状态                    │
│ - revert()：按顺序回滚一批 patch                    │
│ - listCheckpoints() / getCheckpoint()               │
│                                                     │
│ 接收调用方传入的 WorkspaceRef / workdir             │
│ 依赖 DiffEngine 计算文件差异                        │
└───────────────────┬─────────────────────────────────┘
                    │ 委托持久化
                    ▼
┌─────────────────────────────────────────────────────┐
│ SnapshotStore（持久化子系统）                         │
│                                                     │
│ 两层存储分工：                                       │
│ ┌─────────────────────┐  ┌────────────────────────┐ │
│ │ services/database   │  │ services/storage       │ │
│ │ (SQL 索引)          │  │ (文件 artifact)        │ │
│ │                     │  │                        │ │
│ │ snapshot_checkpoint │  │ patch diff 大对象      │ │
│ │ snapshot_patch      │  │ staging → stable key   │ │
│ └─────────────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 主要组件职责

| 组件 | 职责 | 说明 |
|------|------|------|
| `SnapshotService` | Turn 检查点管理、message cursor 记录、diff 计算、restore/revert 执行 | 核心层，对外暴露的主接口 |
| `DiffEngine` | 文件差异计算（git diff / shadow copy 对比） | 核心层内部，不对外暴露 |
| `SnapshotStore` | checkpoint/patch 元数据读写 + artifact 文件读写 | 持久化子系统，被核心层调用 |
| `services/database` | snapshot_checkpoint / snapshot_patch 表的 SQL 操作 | 外部依赖，store 层使用 |
| `services/storage` | patch artifact 大对象的文件读写 | 外部依赖，store 层使用 |

### 核心层与 store 层的分工

| 关注点 | 核心层 | store 层 |
|--------|--------|---------|
| diff 计算 | 负责 | 不参与 |
| restore / revert 执行 | 负责文件恢复；消息回滚由上层编排调用 message/session 层 | 不参与 |
| checkpoint 元数据读写 | 调用 store | 负责（SQL） |
| patch artifact 读写 | 调用 store | 负责（文件） |
| 保留策略决策 | 负责（决定清理什么） | 负责（执行清理指令） |
| artifact 与 DB 一致性 | 不关心细节 | 负责（staging + orphan cleanup） |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. 两层存储分离（SQL 索引 + 文件 artifact）

checkpoint 元数据和 patch 元数据存入 SQLite（支持关系查询），实际 diff artifact 内容存入文件系统（避免 DB 膨胀）。两者通过 `artifact_path` 字段关联。

**选择理由**：
- diff artifact 可能很大（整个 Turn 的文件变更），放入 SQLite 会导致 DB 膨胀和查询性能下降
- 元数据需要按 sessionId / runId / turnId 做关系查询，且需要保存 message cursor，SQLite 天然适合
- 清理策略可以独立删除旧 artifact（节省磁盘），保留元数据作为审计历史

### 2. Patch Row First + Staging + Finalize（artifact 写入策略）

capture 阶段先创建 patch 元数据行（`artifact_path = null`），再写 artifact。artifact 写入使用 staging key（`["snapshot", "staging", patchId]`），写完后 finalize 到稳定 key，最后更新 DB 中的最终 `artifact_path`。

**选择理由**：
- SQLite 事务无法覆盖文件系统写入，两者不在同一原子事务中
- patch 元数据先落库，保证即使 artifact 写入失败，审计链仍然完整
- staging 机制确保 artifact 写入中途失败不会留下半成品被 DB 引用
- finalize 成功但 DB 更新失败时，稳定 artifact 会成为 orphan，可通过 `cleanupOrphanArtifacts()` 后台清理

### 3. 核心层不感知存储细节

`SnapshotService` 通过 `SnapshotStore` 接口读写数据，不直接操作 database 或 storage。store 层的 staging/finalize/orphan cleanup 逻辑对核心层透明。

**选择理由**：
- 核心层关注 diff/restore/revert 的业务语义，不应被存储一致性问题污染
- store 层可以独立演进存储策略（如未来迁移到 S3），不影响核心层

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/snapshot/
├── index.ts                # 公共接口：导出 SnapshotService、类型
├── service.ts              # SnapshotService：track / diff / restore / revert
├── diff-engine.ts          # DiffEngine：文件差异计算
├── types.ts                # 公共类型：SnapshotCheckpoint、SnapshotPatch、SnapshotDiff
│
├── store/
│   ├── index.ts            # store 公共接口
│   ├── checkpoint-store.ts # checkpoint 元数据的 SQL 读写
│   ├── patch-store.ts      # patch 元数据的 SQL 读写
│   ├── artifact-store.ts   # artifact 文件的 staging/finalize/read/delete
│   └── orphan-cleanup.ts   # orphan artifact 清理逻辑
│
└── __tests__/
    ├── service.test.ts
    ├── diff-engine.test.ts
    └── store/
        ├── checkpoint-store.test.ts
        ├── patch-store.test.ts
        └── artifact-store.test.ts
```

### 文件职责定位

| 文件 | 定位 | 对外稳定性 |
|------|------|-----------|
| `service.ts` | 核心业务逻辑 | 稳定接口（track/diff/restore/revert） |
| `diff-engine.ts` | diff 计算实现 | 内部实现，可替换（git diff vs shadow copy） |
| `types.ts` | 共享类型 | 稳定，跨模块引用 |
| `store/checkpoint-store.ts` | SQL 读写 | 内部实现，接口稳定 |
| `store/artifact-store.ts` | 文件读写 + staging | 内部实现 |
| `store/orphan-cleanup.ts` | 后台清理 | 内部实现 |

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. Artifact 与 DB 的非事务一致性

SQLite 事务无法覆盖文件系统写入。snapshot/store 必须承认并管理这种边界：

- artifact 写入使用 staging → finalize 两步
- DB 记录 `artifact_path` 可为 null（`fileCount = 0` 表示无变更；`fileCount > 0` 表示 artifact 已清理或写入失败）
- orphan artifact（finalize 成功但 DB 更新失败）通过后台 cleanup 处理
- 写入接口幂等：重复调用同一 `patchId` 不产生冲突

**代价**：实现复杂度高于"全部放 DB"方案。但 DB 膨胀的代价更大。

### 2. DiffEngine 的实现策略

MVP 阶段 DiffEngine 可使用 `git diff`（依赖 workdir 是 git 仓库）或 shadow copy 对比（在 track 时复制文件快照，diff 时逐文件比较）。

**放弃的方案**：使用 git stash 或 git commit 作为检查点机制。原因：会污染用户的 git 历史，且在非 git 仓库场景不可用。

**当前策略**：DiffEngine 作为内部接口，允许后续替换实现，不影响 SnapshotService 的公共 API。

### 3. restore / revert 依赖 active writer 检查

restore / revert 操作会修改工作区文件，必须在确认当前没有 active Run / workspace-rw Task 正在写入同一工作区后执行。这个检查由上层 revert 编排调用 `runtime/run-manager` 和 `runtime/tasks` 完成，而不是由 `SandboxLease` 充当权威锁。

**代价**：没有显式的读写锁机制，依赖上层在调用 restore 前做 active writer 检查。好处是 snapshot 不强依赖 sandbox；在 sandbox 未启动的 personal agent / host-local 模式下，restore/revert 仍然有一致的并发保护语义。
