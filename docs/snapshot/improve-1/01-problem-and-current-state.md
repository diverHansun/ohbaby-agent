# 1. 问题与现状代码分析

> 本轮 improve-1 的战略方向：**换引擎、保元数据层**。用 opencode 的旁路 git 仓库（git-sidecar）替换自研 `ShadowDiffEngine`，保留 ohbaby 的 SQLite checkpoint 元数据 + MessageCursor + run-hook 适配器。本文先盘点现状，再按"git 引擎是否消解"对每个问题重新定性。

## 1.1 模块概况

Snapshot 模块位于 `packages/ohbaby-agent/src/snapshot/`，共 9 个文件（6 源文件 + 3 测试文件），约 1300 行源代码。职责是：**在 agent run 的前后对工作区文件做完整追踪和差异记录**。

### 文件结构

```
snapshot/
├── index.ts                  # 统一导出
├── types.ts                  # 类型定义 + 1 基类 + 6 子类 Error（共 7 种）
├── store.ts                  # SQLite + Storage 持久化层
├── service.ts                # 业务编排层
├── diff-engine.ts            # 文件级 diff 计算引擎（ShadowDiffEngine）
├── run-hook-adapter.ts       # RunWorker 钩子适配器
├── diff-engine.unit.test.ts
├── run-hook-adapter.unit.test.ts
└── snapshot.integration.test.ts  # 448 行端到端测试
```

### 核心 API 流程

```
track(checkpoint)    →  记录文件基线（当前为 in-memory）
  ↓ agent runs, files change
capture(checkpoint)  →  计算差异 → 持久化 patch artifact
  ↓
diff(from, to?)      →  对比 checkpoint 之间或与当前工作区的差异
restore(checkpoint)  →  逆向应用所有 patch，恢复工作区到 checkpoint 状态
```

## 1.2 战略转向的依据

### 1.2.1 "sandbox 无 git" 假设不成立

原方案 02 的 P0-1 备选 B（git-based diff）被否，理由是"sandbox 中可能没有 git"。核对代码后该假设站不住脚：

- `project/project-identifier.ts` 通过 `execFileAsync("git", ["rev-list", …])` 探测项目提交历史，`VcsType = "git"`（`project/types.ts:1`）。
- `project/project-manager.ts:24,75` 检测 `.git`、标注 `vcs: "git"`。
- `project/project.integration.test.ts` 直接 `execFile("git", …)`。

即 ohbaby 的 project 层**已经依赖 git 二进制**。host 侧有 git 是既成事实。

### 1.2.2 我们手工设计的一切，git 免费提供

在 brainstorming 过程中，为"自研无 git 路线"曾设计了一整套：sha256 内容寻址 blob、manifest、崩溃写序（先 blob 后 manifest）、mark-and-sweep GC、.gitignore 解析。**这些全部是 git 对象库的既有能力**。opencode 把它们全部下沉给了 git（见 `03-reference-opencode-and-kimi.md`）。继续自研等于重新发明 git。

### 1.2.3 opencode 模型的本质

opencode 的 snapshot（`opencode/packages/opencode/src/snapshot/index.ts`）使用**旁路 git 仓库**：

- `--git-dir` 指向数据目录里的独立 gitdir，`--work-tree` 指向真实工作区。
- **不要求工作区本身是 git 仓库**——自己 `git init` 一个 sidecar，不污染工作区，只要 `git` 二进制在 PATH。
- `track()` = `git add --all` + `git write-tree` → 返回 tree hash，即 snapshot 身份。
- `restore(hash)` = `read-tree` + `checkout-index -a -f`。
- `diff/patch` 走 `git diff`。
- GC = 后台每小时 `git gc --prune=7.days`。
- `.gitignore` 经 sidecar 的 `info/exclude` 同步 + `git check-ignore` 原生尊重。
- Windows 适配：`core.autocrlf=false`、`core.longpaths=true`、`core.symlinks=true`、`core.quotepath=false`。

### 1.2.4 ohbaby 必须保留的不对称能力

opencode **没有** ohbaby 需要的两样东西：

1. **MessageCursor**（`messageCursorBefore`/`messageCursorAfter`，`types.ts:3-7,16-17`）——把 checkpoint 锚定到会话消息位置，支撑"恢复到某条消息之前"。
2. **session/run/turn 元数据 + 幂等/并发机制**（`captureLocks`、`createPatchIfAbsent` 的 `BEGIN IMMEDIATE`）。

因此采用**混合方案**：git 当引擎，ohbaby 元数据层留在上面，checkpoint 记录从"内存 baseline + base64 artifact"改为"存 git commit SHA"。

## 1.3 问题清单与重新定性

| 编号 | 问题 | 位置 | 原严重度 | git 引擎下的定性 |
|------|------|------|----------|------------------|
| 1 | baseline 存内存 Map，进程崩溃丢失 | `diff-engine.ts:205` | 🔴 架构级 | **消解**：git 对象库持久化，重启天然安全 |
| 6 | 硬编码目录排除列表 | `diff-engine.ts:23-29` | 🟢 | **消解**：git 原生 `.gitignore` + `check-ignore` |
| 7 | 全量文件读取入内存 | `diff-engine.ts:57-82` | 🟢 | **消解**：git 增量 add + 对象库，不再全量读入内存 |
| 2 | hook 异常被静默吞掉 | `runtime/run-manager/worker.ts:400-404` | 🟡 | **保留**：与引擎无关，仍需 P0-2 可观测 |
| 3 | `enableSnapshots` 默认关闭 | `adapters/ui-persistent.ts:381` | 🟡 | **保留**：仍按 P0-3 默认关 + CLI flag |
| 4 | 无对外命令/TUI 入口 | `commands/` | 🟡 | **保留**：记录为已知缺口，本轮不做 |
| 5 | TUI `snapshot.ts` 命名混淆 | `ohbaby-cli/src/tui/store/snapshot.ts` | ⚪ | **保留**：P2 重命名 |
| 8 | service 同步方法过度包 Promise | `service.ts:339,343,347` | ⚪ | **保留**：P1-3 去 Promise |

### 问题 1（消解）原始链路存档

`track()` 调 `recordBaseline()` 把整个工作区读入 `Map<string, Buffer>`，进程崩溃后 Map 清空但 DB checkpoint 仍在 → 后续 `capture()` → `computeDiff()` → `baselines.get()` 返回 `undefined` → 抛 `SnapshotBaselineNotFoundError` → 被 `worker.ts:400-404` 静默吞掉。**git 引擎下整条链消失**：baseline 是 commit 对象，重启后 `git diff <commit>` 直接可用。

### 问题 2（保留）—— hook 异常静默

```typescript
// runtime/run-manager/worker.ts:396-405
private async executeHook(point, context): Promise<void> {
  try {
    await this.deps.hookExecutor?.execute(point, context);
  } catch {
    // Hooks are observers in MVP; a hook failure must not stop the run.
  }
}
```

catch 块全空：无日志、无事件。snapshot 失败时无任何途径感知。注意 `worker.ts:384-394` 已有私有 `publish(scope, event, data)` 方法（`run/${string}` scope，内部已吞 publish 异常），P0-2 直接复用即可。

### 问题 3（保留）—— 默认关闭

```typescript
// adapters/ui-persistent.ts:379-383
createSnapshotExecutor({ db, enabled: options.enableSnapshots === true, … })
```

`enabled !== true` 时 `createSnapshotExecutor` 返回 `undefined`，被 `composeHookExecutors` 过滤。结论：保持默认关，新增 `--enable-snapshots` flag + 文档（P0-3）。

### 问题 8（保留）—— Promise 包装

```typescript
// service.ts
listCheckpoints(...): Promise<…> { return Promise.resolve(this.store.listCheckpoints(...)); }
getCheckpoint(...):   Promise<…> { return Promise.resolve(this.store.getCheckpoint(...)); }
getPatches(...):      Promise<…> { return Promise.resolve(this.store.getPatches(...)); }
```

SQLite（better-sqlite3）是同步 API，无实际异步。P1-3 去包装。

## 1.4 现状架构数据流（保留参考）

```
createPersistentUiBackendClient(options)           [ui-persistent.ts]
  ├─ createSnapshotExecutor({ enabled, … })         [ui-persistent.ts:379-386]
  │    enabled === true ? createSnapshotHookExecutor : undefined
  │      └─ createSnapshotRunWorkerHook → { track(context), capture(context, state) }
  ├─ composeHookExecutors([options.hookExecutor, snapshotExecutor])
  └─ createInProcessUiBackendClient({ hookExecutor })
       └─ RunManager → RunWorker.start()
            ├─ executeHook("pre-run")  → hook.track()   → service.track()  → diffEngine.recordBaseline()
            ├─ consumeLifecycle()      (agent 实际执行)
            └─ executeHook("post-run") → hook.capture()  → service.capture() → diffEngine.computeDiff() + store.writeArtifact()
```

**混合方案下的变化点**：`diffEngine.recordBaseline/computeDiff` 内部实现换成 git；`store.writeArtifact` 整条 base64 落盘链路移除，改为在 checkpoint/patch 行存 git commit SHA。`track/capture/diff/restore` API 表面与 hook 适配器**不变**。

## 1.5 现有持久化与并发机制（必须保留）

实施 git 引擎时这些是约束，不得回归：

1. **capture 幂等 + 并发锁**：`service.ts:132` `captureLocks` 串行化同一 checkpoint 的并发 capture；`store.ts:234` `createPatchIfAbsent` 用 `BEGIN IMMEDIATE` 事务保证"一个 checkpoint 至多一个 patch"。
2. **Storage 原子写**：`services/storage/storage.ts:99` `writeText` 底层走 `atomic-writer.ts` 的 temp+rename，并有 per-key 排他锁。**结论**：原 `writeArtifact` 的 staging→read-verify→stable 三步本就冗余；但本轮该路径整体移除（git 接管落盘），此结论仅作存档。
3. **路径逃逸防护**：`diff-engine.ts:35-44` `resolveRelativePath` 防 artifact 路径逃出 workdir。git 引擎下由 git 自身约束 work-tree 边界，restore 时仍需对 git 输出的路径做 work-tree 内校验。

## 1.6 测试覆盖评估

**现有优点**：
- `diff-engine.unit.test.ts`：diff 计算、applyReverse、artifact 序列化/反序列化、路径安全。
- `run-hook-adapter.unit.test.ts`：钩子适配器 pre-run/post-run 生命周期。
- `snapshot.integration.test.ts`（448 行）：track→capture→diff→restore 全流程、幂等 capture、flaky storage retry、preflight、cursor 更新、list/过滤。

**换引擎后测试缺口**（详见 `04-testing-and-acceptance.md`）：
- 缺 sidecar gitdir 初始化、tree 捕获、`git diff`/`restore` 的引擎级测试。
- 缺 `.gitignore` 原生尊重验证。
- 缺 ref/gc 生命周期（删 checkpoint → 删 ref → gc 回收）验证。
- 缺 Windows CRLF/longpaths 场景。
- 缺"无 git 二进制时优雅降级"验证。
- 缺 hook 静默吞异常的可观测性测试（P0-2）。
