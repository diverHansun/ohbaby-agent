# 4. 测试与验收标准（git 引擎）

## 4.1 测试策略

三层结构保持，内容按 git 引擎重写：

```
snapshot/
├── diff-engine.unit.test.ts        ← GitSnapshotEngine 引擎级（需 git 二进制 + 临时 gitdir/workdir）
├── run-hook-adapter.unit.test.ts   ← 钩子适配器（fake service，不碰 git）
└── snapshot.integration.test.ts    ← track→capture→diff→restore 全流程（真实 git sidecar）
```

**测试环境前提**：CI/本地需有 `git` 二进制。引擎测试用 `fs.mkdtemp` 临时 workdir + 独立临时 gitdir，测试后清理。service 层测试用 fake `DiffEngine`（不依赖 git），验证编排/幂等/cursor。

## 4.2 GitSnapshotEngine —— 引擎级测试（diff-engine.unit.test.ts 重写）

| 用例 ID | 描述 | 前置条件 | 预期结果 |
|---------|------|----------|----------|
| UT-GE-01 | 首次 `recordBaseline` 惰性 init sidecar gitdir | 临时 workdir（含若干文件） | gitdir 被创建，返回非空 commit SHA，`refs/snapshots/<ckptId>` 存在 |
| UT-GE-02 | `recordBaseline` 返回的 commit 可达且包含全部非忽略文件 | 同上 | `git ls-tree -r <commit>` 含所有文件，排除 `.gitignore` 命中项 |
| UT-GE-03 | `computeDiff` 正确识别 added/modified/deleted | track 后改/增/删文件 | `files` 三态正确，`fileCount`/`summary` 准确，返回新 commit |
| UT-GE-04 | `.gitignore` 原生尊重 | workdir 含 `.gitignore` 排除 `build/` | `build/` 下变更不出现在 diff |
| UT-GE-05 | `restoreTo` 还原工作区到指定 commit，**含删除新增文件** | track→改文件**+新增文件**→restoreTo(pre) | 工作区字节级回到 track 态：改动还原**且新增文件被删**（验证 checkout-index 不删的坑已被补） |
| UT-GE-06 | `diffWorkingTree` 实时路径只读、不建 commit/ref | track→改文件→diffWorkingTree | 返回正确 FileDiff；`refs/snapshots/<ckpt>/post` **不存在**（无副作用） |
| UT-GE-06b | `diffBetween` 两 commit 净差异 | 两个 checkpoint commit | name-status 结果正确 |
| UT-GE-07 | `dropRef` + `gc(prune="now")` 回收不可达对象 | track+capture 后 dropRef 再 `gc(workdir,"now")` | pre+post 两 ref 均消失；两 commit `git cat-file -e` 失败（**必须 prune=now，7.days 不会删新对象**） |
| UT-GE-07b | **post commit 在 gc 后仍可达** | track→capture→`gc(workdir,"now")`（不 dropRef） | `git cat-file -e <post_tree_ref>` 仍成功（验证 post 有独立 ref，不被误删） |
| UT-GE-08 | 仍被其他 ref 引用的对象不被 gc 删除 | 两 checkpoint 共享文件 blob，删其一 ref + `gc(now)` | 共享 blob 仍存活（mark-sweep 正确性） |
| UT-GE-09 | 缺 git 二进制时抛 `GitNotAvailableError` | mock `git --version` 失败 | 抛 `GitNotAvailableError`，不静默成功 |
| UT-GE-10 | git 命令非 0 退出转 `GitCommandError`/降级 | mock git 返回 code≠0 | 按约定抛错或降级，stderr 进错误信息 |
| UT-GE-11 | 单 gitdir 串行锁防命令交错 | 并发触发两次 recordBaseline | 不产生 index.lock 冲突，两次都成功 |
| UT-GE-12 | Windows CRLF 不污染 diff | autocrlf=false 下含 CRLF 文件 | 未改动文件不被误报为 modified |

## 4.3 SnapshotService —— 编排/幂等测试（用 fake DiffEngine）

| 用例 ID | 描述 | 前置条件 | 预期结果 |
|---------|------|----------|----------|
| UT-SV-01 | `track` 把 commit 写入 `pre_tree_ref` | fake engine 返回固定 commit | checkpoint 行 `preTreeRef` = 该 commit |
| UT-SV-02 | `capture` 把 commit 写入 `post_tree_ref` | fake engine computeDiff 返回 commit+fileCount | patch 行 `postTreeRef`/`fileCount` 正确 |
| UT-SV-03 | 同 checkpoint 并发 capture 幂等 | 并发两次 capture（captureLocks） | 只创建一个 patch（`createPatchIfAbsent`） |
| UT-SV-04 | `restore` 旧引擎 checkpoint（preTreeRef NULL）抛错 | 构造 preTreeRef=NULL | 抛 `SnapshotEngineMismatchError` |
| UT-SV-04b | `diff(from,to)` 任一 checkpoint preTreeRef NULL 抛错 | from 或 to 的 preTreeRef=NULL | 抛 `SnapshotEngineMismatchError` |
| UT-SV-05 | `restore` 有 activeWriter 时抛冲突 | activeWriterChecker 返回 true | 抛 `SnapshotConflictError`，不调用 restoreTo |
| UT-SV-06 | cursor 更新保持现状语义 | capture 带 messageCursorAfter | checkpoint `message_cursor_after` 更新 |
| UT-SV-07 (P1-3) | `listCheckpoints`/`getCheckpoint`/`getPatches` 同步返回 | 调用三方法 | 返回值非 Promise |
| UT-SV-08 | `diff(from)` 走 `diffWorkingTree`，`diff(from,to)` 走 `diffBetween` | 分别调用两种 diff | 调用对应 engine 方法；`diff(from)` **不**触发 computeDiff/建 commit |

## 4.4 集成测试（snapshot.integration.test.ts 重写，真实 git）

| 用例 ID | 描述 | 前置条件 | 预期结果 |
|---------|------|----------|----------|
| IT-GE-01 | track→capture→diff→restore 全流程 | 真实 sidecar + workdir | 各步结果正确，restore 后工作区回到 track 态 |
| IT-GE-02 | **模拟进程重启**：track→丢弃 engine 实例→新 engine→capture | 新 engine 指向同 gitdir | capture 正常（git 对象库持久，**不再抛 baseline not found**） |
| IT-GE-03 | 连续多轮 track→capture | 多 checkpoint | 每轮 diff 独立正确，refs 各自存在 |
| IT-GE-04 | restore 到任意历史 checkpoint | 多 checkpoint 链 | 还原到对应 commit 状态正确 |
| IT-GE-05 | 删除 checkpoint → dropRef → gc → 空间回收 | 多 track/capture 后删部分 | 被删 checkpoint 的 ref 消失，gc 后对象回收，其余可用 |
| IT-GE-06 | 大量文件（100+）+ 大文件排除 | 100 小文件 + 1 个 >2MB 文件 | 小文件入树，大文件按 P1 大小阈值排除（若实现） |
| IT-GE-07 | `.gitignore` 端到端 | workdir 带 .gitignore | 忽略项全程不进 snapshot |

## 4.5 P0-2：hook 异常可观测 —— 测试用例

| 用例 ID | 描述 | 前置条件 | 预期结果 |
|---------|------|----------|----------|
| UT-HE-01 | hook 抛异常时 publish `snapshot.hook.failed` | mock hookExecutor 抛异常 | `streamBridge.publish` 被调用，事件类型 `snapshot.hook.failed`，含 point/error |
| UT-HE-02 | hook 抛异常后 run 不中断 | 同上 | `consumeLifecycle` 正常，run 完成 |
| UT-HE-03 | 无 hookExecutor 不影响流程 | hookExecutor=undefined | 无异常无事件 |
| UT-HE-04 | publish 自身失败不影响 run | mock publish 抛异常 | run 正常完成（publish 已内部吞异常） |

## 4.6 P0-3 / 无 git 降级 —— 测试用例

| 用例 ID | 描述 | 前置条件 | 预期结果 |
|---------|------|----------|----------|
| E2E-EN-01 | `enableSnapshots: true` + 有 git 端到端工作 | 真实 sandbox workdir + git | DB 有 checkpoint 行（含 pre_tree_ref），sidecar 有对应 ref |
| E2E-EN-02 | 默认（未开启）行为与改动前一致 | 不传 enableSnapshots | snapshot 完全不运行，run 行为无变化 |
| E2E-EN-03 | `--enable-snapshots` CLI flag 生效 | 传 flag | snapshot executor 被装配 |
| E2E-EN-04 | 开启但无 git 二进制 → 优雅降级 | mock git 缺失（首次 track 调用 engine） | 引擎抛 `GitNotAvailableError`，被 hook 层捕获 → publish warn 事件，run 不阻断；后续该 run 不再重试。**注意捕获点**：引擎按 run 惰性首用，`GitNotAvailableError` 在 hook `execute` 内被 worker 的 `executeHook` catch（P0-2）观测，而非构造期 |

## 4.7 验收标准

### 功能验收

| 标准 | 验收方式 | 阻塞项 |
|------|----------|--------|
| 进程重启后 capture 不抛 baseline not found | IT-GE-02 通过 | P0 引擎 |
| restore 字节级还原工作区 | UT-GE-05 + IT-GE-04 通过 | P0 引擎 |
| `.gitignore` 原生尊重 | UT-GE-04 + IT-GE-07 通过 | P0 引擎 |
| 删 checkpoint 后对象可被 gc 回收，共享对象不误删 | UT-GE-07/08 + IT-GE-05 通过 | P1 |
| hook 异常可被事件观察 | UT-HE-01 通过 | P0-2 |
| 无 git 时优雅降级 | E2E-EN-04 通过 | P1 |
| 默认关闭时 run 行为不变 | E2E-EN-02 通过 | P0-3 |
| 所有现有非 snapshot 测试仍通过 | `pnpm test` 全绿 | 全部 |

### 性能验收

| 标准 | 验收方式 | 阻塞项 |
|------|----------|--------|
| track（git add+write-tree+commit）不显著拖慢 run | 100 文件/~500KB 临时目录，`service.track()` 10 次 wall-clock 均值，单次 < 500ms | P0 引擎 |
| capture diff 计算高效 | 同基准，`computeDiff()` 10 次均值，单次 < 500ms | P0 引擎 |
| gc 不阻塞主流程 | gc 作为独立可调用方法，不在 track/capture 关键路径同步执行 | P1 |

### 代码质量验收

| 标准 | 验收方式 | 阻塞项 |
|------|----------|--------|
| TypeScript 编译无错误 | `pnpm typecheck` | 全部 |
| ESLint 无新增 warning | `pnpm lint` | 全部 |
| 新增代码覆盖率 ≥ 80% | vitest coverage | 全部 |
| 无 console.log 残留（用事件/结构化日志） | code review | P0-2 |
| 移除 base64 artifact 死代码（writeArtifact 等） | code review + 无残留引用 | P0 引擎 |

## 4.8 回归风险检查清单

PR 合并前确认：

- [ ] 引擎级用例 UT-GE-01..12（含 06b/07b）全部通过
- [ ] service 编排用例 UT-SV-01..08（含 04b）全部通过
- [ ] 集成用例 IT-GE-01..07 全部通过
- [ ] hook 可观测用例 UT-HE-01..04 全部通过
- [ ] 默认开关用例 E2E-EN-01..04 全部通过
- [ ] schema 迁移 `00X_snapshot_git_engine` 可正向执行；旧库升级不报错
- [ ] `captureLocks` + `createPatchIfAbsent` 幂等/并发语义未回归
- [ ] MessageCursor before/after 更新语义未回归
- [ ] 不开启 snapshot（默认）时 agent run 行为与改动前完全一致
- [ ] Windows 下 CRLF/长路径/非 ASCII 文件名场景验证通过
- [ ] `run-hook-adapter.ts` 的 track/capture 签名未变，上层接线无需改

## 4.9 迁移专项验证

- [ ] 旧引擎遗留 checkpoint（`pre_tree_ref` 为 NULL）调用 restore/diff 时抛 `SnapshotEngineMismatchError`，不崩溃
- [ ] 旧引擎遗留 patch（`post_tree_ref` 为 NULL）在 `diff(from,to)` / 后续操作中被识别，不静默产出错误结果
- [ ] sidecar gitdir 路径在 win32 下不触发 Storage key 校验（独立解析，非 Storage key）
- [ ] gitdir 与工作区物理分离，删除 gitdir 不影响工作区文件
- [ ] 引擎首用按 workdir 惰性建 gitdir；构造期不依赖 projectId/workdir（对齐 `ui-persistent.ts:220-233` 单例约束）
