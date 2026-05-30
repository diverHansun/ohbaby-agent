# 2. 设计与迁移方案（混合：git 引擎 + ohbaby 元数据层）

## 2.1 总体策略

| 优先级 | 目标 | 内容 |
|--------|------|------|
| P0（必须做） | 换引擎，让 snapshot 重启安全且可工作 | GitSnapshotEngine、schema 迁移、service 接线、hook 可观测、默认开关 |
| P1（应该做） | 健壮性与一致性 | ref/gc 生命周期、`.gitignore`、去 Promise、无 git 降级 |
| P2（可以做） | 技术债 | TUI 重命名、CLI/TUI 入口、路径前缀集中 |

**核心原则**：文件追踪/存储/去重/GC 全部下沉给 git；ohbaby 只保留会话语义层（checkpoint 元数据 + cursor + 幂等/并发 + hook 接线）。

## 2.2 目标架构

```
SnapshotService (编排，API 表面不变)
  ├─ track / capture / diff / restore / list / getCheckpoint / getPatches
  ├─ captureLocks + createPatchIfAbsent 幂等并发      ← 保留
  └─ MessageCursor / session·run·turn 元数据           ← 保留
        │  (DiffEngine 接口作为测试 seam)
        ▼
GitSnapshotEngine implements DiffEngine (替换 ShadowDiffEngine)
  └─ 旁路 git 仓库
       gitdir   = <appDataDir>/snapshot/<projectId>/<workdirHash>
       worktree = checkpoint.workdir (真实工作区)
       snapshot = commit-tree 产生的 commit，引用挂在 refs/snapshots/<checkpointId>
```

### 2.2.1 旁路 gitdir 位置（**惰性、仅由 workdir 派生**）

> ⚠️ 关键约束（审查发现）：引擎在 `ui-persistent.ts:220-233` 的 `createDefaultSnapshotService` 中作为**进程单例**构造，此处**拿不到 `projectId`，也拿不到 `workdir`**——workdir 只在 per-run hook 才经 `run-hook-adapter.ts:58`（`context.sandboxLease?.workdir`）到达。因此 gitdir **不能在构造期算**，必须在每次调用时由传入的 `workdir` **惰性派生**（对齐 opencode 在 `InstanceState.make` 内按 `ctx.worktree` 惰性派生，`index.ts:86`）。

复用 `path-resolver.ts` 的 app data 约定（`OHBABY_STORAGE_ROOT` / `XDG_DATA_HOME` / 平台默认），但 **gitdir 不能走 Storage key**（Storage 段禁止路径分隔符，见 `path-resolver.ts:62-67`）。改为独立解析，**只用 workdir 哈希，不含 projectId 段**（workdir 是绝对路径，已足以唯一定位一个工作区；projectId 在构造期不可得且对唯一性冗余）：

```
<storageRoot>/../snapshot-git/<workdirHash>
# 例 (win32): %APPDATA%/ohbaby-agent/snapshot-git/<sha1(workdir).slice(0,16)>
```

- `workdirHash`：`sha1(workdir)` 前 16 hex，避免长路径与字符问题（对齐 opencode `Hash.fast(worktree)`）。
- gitdir 与工作区分离 → 不污染 sandbox，可被独立清理。
- 引擎内部以**解析后的 gitdir 为 key** 维护串行锁 `Map<gitdir, Promise>`（每个 workdir 一把锁）。

## 2.3 GitSnapshotEngine 接口（重设计 DiffEngine）

现有 `DiffEngine` 三方法语义改写。保留接口以便 service 单测用 fake engine。

```typescript
// diff-engine.ts —— 新接口（所有方法都传 workdir，引擎据此惰性派生 gitdir）
export interface DiffEngine {
  /** track：捕获工作区为 pre commit，挂 refs/snapshots/<ckpt>，返回 commit SHA。 */
  recordBaseline(checkpointId: string, workdir: string): Promise<string>;
  /** capture：捕获工作区为 post commit，挂 refs/snapshots/<ckpt>/post，
   *  再 diff pre↔post，产出文件级 diff + post commit SHA。 */
  computeDiff(checkpoint: SnapshotCheckpoint): Promise<ComputedSnapshotPatch>;
  /** diff(from) 实时路径：只读地对比 pre commit 与当前工作区，不建 commit/ref。 */
  diffWorkingTree(checkpoint: SnapshotCheckpoint): Promise<readonly FileDiff[]>;
  /** 将工作区**精确**还原到指定 commit（含删除 commit 中不存在的新增文件）。 */
  restoreTo(workdir: string, commit: string): Promise<void>;
  /** 对比两个 snapshot commit（checkpoint 间净 diff）。 */
  diffBetween(workdir: string, from: string, to: string): Promise<readonly FileDiff[]>;
  /** 删除 checkpoint 的 pre + post 两个 ref（释放可达性，供 gc 回收）。 */
  dropRef(checkpointId: string, workdir: string): Promise<void>;
  /** 对 workdir 对应的 sidecar 跑 gc；prune 可指定（测试用 "now"，生产默认 "7.days"）。 */
  gc(workdir: string, prune?: string): Promise<void>;
}
```

> 说明（含审查修正）：
> - `recordBaseline` 返回值由 `void` 改为 `string`（commit SHA）；`applyReverse(workdir, artifact)` 被 `restoreTo(workdir, commit)` 取代。`ComputedSnapshotPatch` 去掉 `filePatches`（base64 内容），新增 `commit: string`。
> - **pre / post 两个 commit 各有独立 ref**（`refs/snapshots/<ckpt>` 与 `refs/snapshots/<ckpt>/post`）。否则 post commit 无 ref → 不可达 → 被 `git gc --prune` 删除 → `post_tree_ref` 失效、`diff(from,to)` 崩。
> - **`computeDiff`（capture，建 post commit）与 `diffWorkingTree`（diff 实时路径，只读不建 commit）分离**。原设计用 `computeDiff` 兼任二者会导致每次 `diff(from)` 都建一个 post commit 并覆盖 ref，是错误的。
> - `dropRef` / `gc` 改为传 `workdir` 以惰性定位 sidecar。

### 2.3.1 git 命令映射（实施级）

所有命令统一前缀（对齐 opencode `index.ts:36-38`）：

```
core  = ["-c","core.longpaths=true","-c","core.symlinks=true"]
cfg   = ["-c","core.autocrlf=false", ...core]
quote = [...cfg, "-c","core.quotepath=false"]
args(cmd) = ["--git-dir", gitdir, "--work-tree", worktree, ...cmd]
```

**init（首次惰性）**：
```
git init                       (env: GIT_DIR=gitdir, GIT_WORK_TREE=worktree)
git --git-dir gitdir config core.autocrlf false
git --git-dir gitdir config core.longpaths true
git --git-dir gitdir config core.symlinks true
git --git-dir gitdir config core.fsmonitor false
```
> ⚠️ 不对称（照搬 opencode，勿"统一"）：**`init` 用环境变量** `GIT_DIR`/`GIT_WORK_TREE`（`index.ts:300-302`），**其余命令用 `args()` 的 `--git-dir`/`--work-tree` 旗标**（`index.ts:90`）。`git init` 对 `--git-dir` 的目标解析与其它子命令不同，把 init 改成旗标式会建错位置。

> 复用辅助：`capture-tree(ckpt, refName)` = add → write-tree → commit-tree → update-ref `refName`，返回 commit。pre 与 post 共用此流程，只是 refName 不同。

**recordBaseline（track，建 pre）**：
```
# add：尊重工作区 .gitignore（standard exclude）。首版可简化为：
git [cfg] args(["add","--all","."])
# P1 增强（移植 opencode）：-z NUL 分隔 + check-ignore 二次过滤 + 大文件排除（见 03 要点3）
PRE = capture-tree(ckpt, "refs/snapshots/"+ckpt)
→ 返回 PRE
```

**computeDiff（capture，建 post + diff）**：
```
POST = capture-tree(ckpt, "refs/snapshots/"+ckpt+"/post")    # 独立 ref，保证可达
NAMESTATUS = git [quote] args(["diff","--no-ext-diff","--name-status","--no-renames",
                               PRE_COMMIT, POST, "--", "."])  # PRE_COMMIT 取自 checkpoint.preTreeRef
→ 解析每行 (A|M|D, path) → FileDiff[]、summary、fileCount、commit=POST
```

**diffWorkingTree（diff(from) 实时路径，只读不建 commit）**：
```
git [cfg]  args(["add","--all","."])                          # 仅刷新 sidecar 暂存区（scratch）
git [quote] args(["diff","--no-ext-diff","--name-status","--cached", PRE_COMMIT, "--", "."])
→ FileDiff[]   # 不 write-tree、不 commit、不 update-ref
```
> 注：`add` 会改 sidecar 的 index，但 index 是 sidecar 私有 scratch，可接受（对齐 opencode `diff(hash)` 的 `add → diff --cached`，`index.ts:492-510`）。

**restoreTo（精确还原，含删除新增文件）**：
```
# checkout-index 只写 tree 中的文件，不会删除"工作区有、tree 没有"的新增文件。
# 必须显式删除多余文件，否则 restore 后工作区 ≠ checkpoint 态（对齐 opencode revert 的 remove，index.ts:407-408,480-484）。
git [cfg]  args(["add","--all","."])                          # 让 index 反映当前工作区
git [core] args(["read-tree","-u","--reset", commit])         # -u/--reset：更新工作区并删除 commit 中已不存在的文件
# 兜底（若 read-tree -u --reset 行为不达预期）：
#   checkout-index -a -f  + 用 `diff --name-only --diff-filter=D <commit>` 枚举多余文件逐个删除
```

**diffBetween**：
```
git [quote] args(["diff","--no-ext-diff","--name-status","--no-renames", from, to, "--", "."])
```

**dropRef（删 pre + post 两个 ref）/ gc**：
```
git args(["update-ref","-d","refs/snapshots/"+checkpointId])         # pre
git args(["update-ref","-d","refs/snapshots/"+checkpointId+"/post"]) # post（不存在则忽略）
git args(["gc", "--prune="+prune])   # 生产默认 "7.days"；测试传 "now" 才能确定性回收
```

### 2.3.2 并发与崩溃安全

- **串行化**：engine 内对同一 gitdir 用 `Map<gitdir, Promise>` 互斥（对齐 opencode `locked()` 信号量），保证 add/write-tree/commit/ref/gc 不交错。与 service 层 `captureLocks` 叠加无冲突（不同粒度）。
- **可达性即生命周期**：snapshot 是挂了 ref 的 commit → `git gc` 不会误删；删 ref 后才可回收 → 精确实现"绑定 checkpoint"。
- **崩溃安全**：git 写对象本身原子；commit-tree 完成才 update-ref，崩溃只会留下未引用的 loose 对象（无害，gc 回收）。

## 2.4 Schema 迁移

新增一个 migration（追加到 `services/database/migrations.ts` 的 `INITIAL_MIGRATIONS` 数组，version 递增，如 `00X_snapshot_git_engine`）。**ALTER 加列，不破坏现有结构**：

```sql
-- snapshot_checkpoint：记录 track 时的 snapshot commit
ALTER TABLE snapshot_checkpoint ADD COLUMN pre_tree_ref TEXT;

-- snapshot_patch：artifact_path 改语义为 post_tree_ref
ALTER TABLE snapshot_patch ADD COLUMN post_tree_ref TEXT;
-- artifact_path 保留列以兼容旧数据（标记弃用），新代码只读写 post_tree_ref
```

对应 `schema.ts` 的 `snapshotCheckpoint` / `snapshotPatch` 表映射新增 `preTreeRef: "pre_tree_ref"` / `postTreeRef: "post_tree_ref"`。

> **迁移注意**：旧数据（base64 artifact）与新数据（commit SHA）不互通。MVP 阶段 snapshot 默认关闭、无生产数据，可直接弃用旧 artifact 列，不做数据回填。若已有数据：旧 checkpoint 的 `pre_tree_ref` 为 NULL，`restore`/`diff` 时识别 NULL → 抛明确错误"该 checkpoint 由旧引擎创建，不支持"。

## 2.5 类型改动（types.ts）

```typescript
// 改：SnapshotCheckpoint 增 preTreeRef
export interface SnapshotCheckpoint {
  // …现有字段不变…
  readonly preTreeRef?: string;   // track 捕获的 commit SHA
}

// 改：SnapshotPatch 用 postTreeRef 取代 artifactPath
export interface SnapshotPatch {
  readonly patchId: string;
  readonly checkpointId: string;
  readonly postTreeRef: string | null;   // 原 artifactPath
  readonly fileCount: number;
  readonly createdAt: number;
}

// 改：ComputedSnapshotPatch 去 filePatches，加 commit
export interface ComputedSnapshotPatch {
  readonly files: readonly FileDiff[];
  readonly summary: SnapshotDiffSummary;
  readonly fileCount: number;
  readonly commit: string;
}

// 删：SnapshotFilePatch / SnapshotPatchArtifact / beforeContentBase64 等
//     （base64 artifact 体系整体移除）

// 新增 Error
export class GitNotAvailableError extends SnapshotError {}      // git 二进制缺失
export class GitCommandError extends SnapshotError {}           // git 退出码非 0
export class SnapshotEngineMismatchError extends SnapshotError {}  // 旧引擎 checkpoint
// 删：InvalidSnapshotArtifactError、ArtifactNotAvailableError（artifact 体系移除后无用）
//     SnapshotBaselineNotFoundError 保留语义→改为 commit 不存在时抛
```

> Error 模型：本轮**不**合并为单 code 注册表（kimi-code 模式）——snapshot 错误仍仅进程内 `try/catch`，不跨序列化边界，保持 1 基类 + 子类层次（见 `03` 模式 1 的结论）。

## 2.6 store.ts 改动

- **删除**：`writeArtifact` / `readArtifact` / `deleteArtifact` / `updatePatchArtifact`（base64 artifact 体系）及 `artifactKey`/`stagingArtifactKey`/`stableArtifactKey` 等路径辅助、`Storage` 依赖。
- **改**：`createPatch` / `createPatchIfAbsent` / `rowToPatch` 用 `post_tree_ref` 取代 `artifact_path`；`createCheckpoint` / `rowToCheckpoint` 增 `pre_tree_ref`。
- **新增**：`updateCheckpointTreeRef(checkpointId, commit)`、`updatePatchTreeRef(patchId, commit)`。
- **保留**：所有 checkpoint/patch 查询（`listPatchesFromCheckpoint`、`listPatchesBetweenCheckpoints`、`getPatchByCheckpoint` 等）、`createPatchIfAbsent` 的 `BEGIN IMMEDIATE` 幂等。
- `SnapshotStoreOptions` 去掉 `storage: Storage`，store 只管 DB；gitdir 解析全部在 `GitSnapshotEngine` 内按 workdir 惰性完成，store 不参与。

## 2.7 service.ts 改动

API 表面与幂等机制保留，内部接线改为 git：

```typescript
async track(params): Promise<SnapshotCheckpoint> {
  const checkpoint = this.store.createCheckpoint({ …, checkpointId, createdAt });
  const commit = await this.diffEngine.recordBaseline(checkpoint.checkpointId, checkpoint.workdir);
  return this.store.updateCheckpointTreeRef(checkpoint.checkpointId, commit);  // 存 pre_tree_ref
}

// capture：captureLocks + createPatchIfAbsent 幂等保留；computeDiff 产出 commit → 存 post_tree_ref
async captureOnce(params): Promise<SnapshotPatch> {
  const checkpoint = this.store.requireCheckpoint(params.checkpointId);
  const existing = this.store.getPatchByCheckpoint(params.checkpointId);
  if (existing) { /* 更新 cursor，返回 existing（已含 post_tree_ref） */ }
  const computed = await this.diffEngine.computeDiff(checkpoint);   // 含 commit
  const created = this.store.createPatchIfAbsent({ patchId, checkpointId, postTreeRef: computed.commit, fileCount: computed.fileCount, createdAt });
  // …幂等分支同现状…
  this.store.updateCheckpointMessageCursor(checkpoint.checkpointId, params.messageCursorAfter);
  return created.patch;
}

async restore(params): Promise<RestoreSnapshotResult> {
  const checkpoint = this.store.requireCheckpoint(params.checkpointId);
  if (this.activeWriterChecker) { /* 同现状，冲突抛 SnapshotConflictError */ }
  if (!checkpoint.preTreeRef) throw new SnapshotEngineMismatchError(checkpoint.checkpointId);
  await this.diffEngine.restoreTo(checkpoint.workdir, checkpoint.preTreeRef);  // 直接还原整棵树
  return { messageCursorBefore: checkpoint.messageCursorBefore };
}

async diff(params): Promise<SnapshotDiff> {
  const from = this.store.requireCheckpoint(params.fromCheckpointId);
  if (!from.preTreeRef) throw new SnapshotEngineMismatchError(from.checkpointId);
  if (!params.toCheckpointId) {
    // 实时路径：只读对比 pre 与当前工作区，**不**建 commit/ref（避免副作用与 ref 覆盖）
    const files = await this.diffEngine.diffWorkingTree(from);
    return { fromCheckpointId, files, summary: summaryFromFiles(files) };
  }
  const to = this.store.requireCheckpoint(params.toCheckpointId);
  if (!to.preTreeRef) throw new SnapshotEngineMismatchError(to.checkpointId);
  const files = await this.diffEngine.diffBetween(from.workdir, from.preTreeRef, to.preTreeRef);
  return { fromCheckpointId, toCheckpointId, files, summary: summaryFromFiles(files) };
}
```

- **restore 语义变化**：从"逆向应用 patch 链"改为"还原整棵树**并删除新增文件**"（见 §2.3.1 restoreTo——`checkout-index` 不删多余文件，必须显式处理）。`revert(patches)` 若仍需保留，借 opencode `revert` 的逐文件 checkout + remove（见 `03` 要点5）。
- **P1-3 去 Promise**：`listCheckpoints`/`getCheckpoint`/`getPatches` 改同步返回（去 `Promise.resolve`）。

## 2.8 cleanup / gc 生命周期（P1）

- **删除 checkpoint**：DB 行 `ON DELETE CASCADE` 已处理 patch 行；新增在删除路径调用 `engine.dropRef(checkpointId, workdir)`——**删 pre 与 post 两个 ref**（`refs/snapshots/<ckpt>` 和 `…/post`）。
- **按龄回收**：提供 `SnapshotService.gc(workdir, prune?)` → `engine.gc(workdir, prune)`（生产默认 `--prune=7.days`，测试用 `--prune=now`）。可由上层定时触发（对齐 opencode 每小时后台 gc，`index.ts:728-736`），本轮只暴露方法，不强制接定时器。
- mark-and-sweep = git gc 本身：删 ref 后对应 commit/tree 不可达 → prune 回收。**注意**：仅当 pre 和 post 两个 ref 都删，该 checkpoint 的两个 commit 才双双变不可达；漏删任一 ref 会让对象残留。

## 2.9 跨模块改动（与引擎无关，沿用原 improve-1）

### P0-2：hook 异常可观测（`runtime/run-manager/worker.ts`）

```typescript
private async executeHook(point, context): Promise<void> {
  try {
    await this.deps.hookExecutor?.execute(point, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.publish(`run/${context.runId}`, "snapshot.hook.failed", { point, error: message });
    // 保留静默策略（不停止 run），但可被观察
  }
}
```

复用已存在的 `publish`（`worker.ts:384-394`，已吞 publish 异常）。

### P0-3：默认开关（保持默认关 + CLI flag）

- `adapters/ui-persistent.ts:381` 不改默认（`=== true`）。
- `packages/ohbaby-agent/src/cli/` 新增 `--enable-snapshots` boolean flag（commander `option('--enable-snapshots', '…')`）。
- 新增"如何开启 + 前提（host 需有 git）"文档。

### P1：无 git 优雅降级

- engine `init` 前 `git --version` 探测；缺失 → 抛 `GitNotAvailableError`。
- `createSnapshotExecutor` 捕获该错误 → 记录一次 warn 事件并将 snapshot 视为未启用（不阻断 run）。对齐"hooks are observers"。

## 2.10 完整文件改动清单

```
packages/ohbaby-agent/src/snapshot/
├── types.ts              ← 改 SnapshotCheckpoint/SnapshotPatch/ComputedSnapshotPatch；增/删 Error
├── diff-engine.ts        ← 核心重写：ShadowDiffEngine → GitSnapshotEngine（git-sidecar）
├── store.ts              ← 删 artifact 体系 + 去 `storage: Storage` 依赖；改列 post_tree_ref/pre_tree_ref；保留幂等查询
├── service.ts            ← track/capture/diff/restore 接线改 git；新增 diffWorkingTree 调用；P1-3 去 Promise；保留 captureLocks
├── run-hook-adapter.ts   ← 接口基本不变（track/capture 签名稳定）
├── index.ts              ← 调整导出（去 artifact 相关，加 git Error）+ 模块边界 docblock
├── diff-engine.unit.test.ts        ← 重写为 git 引擎测试
├── run-hook-adapter.unit.test.ts   ← 保留 + 适配
└── snapshot.integration.test.ts    ← 重写恢复/重启/重命名相关用例

packages/ohbaby-agent/src/services/database/
├── migrations.ts         ← 新增 00X_snapshot_git_engine（ALTER 加列）
└── schema.ts             ← snapshotCheckpoint/snapshotPatch 增列映射

packages/ohbaby-agent/src/runtime/run-manager/
└── worker.ts             ← P0-2：catch 块 publish snapshot.hook.failed

packages/ohbaby-agent/src/adapters/
└── ui-persistent.ts      ← 去掉传给 SnapshotStore 的 `storage:`；构造 GitSnapshotEngine（不在构造期算 gitdir，引擎按 workdir 惰性派生）；无 git 降级；默认值不变（createDefaultSnapshotService @ ui-persistent.ts:220-233）

packages/ohbaby-agent/src/cli/
└── （新增 --enable-snapshots flag） ← P0-3

packages/ohbaby-cli/src/tui/store/
└── snapshot.ts → tui-store.ts  ← P2 重命名（问题 5）
```

## 2.11 不做的改动

| 不改 | 理由 |
|------|------|
| 把 DiffEngine 抽象成插件系统 | 仍只有一个实现（GitSnapshotEngine），YAGNI |
| 合并 Error 为 code 注册表 | snapshot 错误仅进程内，不跨序列化边界（`03` 模式 1） |
| TUI 暴露 snapshot 命令 | 已确认暂不做，先稳核心（问题 4 记为缺口） |
| 全盘改用 opencode（丢 checkpoint 模型） | 会丢失 MessageCursor/会话元数据，已选混合方案 |
| 自研内容寻址 + mark-sweep GC | git 内置，自研等于重造 git |
| 增量文件 watch（chokidar） | git add 已是增量，过早优化 |
