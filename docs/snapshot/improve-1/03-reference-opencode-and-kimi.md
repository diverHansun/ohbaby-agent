# 3. 参考项目设计借鉴（opencode 为主，kimi-code 为辅）

> 主参考：`D:\Projects\Code-cli\opencode`（`packages/opencode/src/snapshot/index.ts`）——本轮直接移植其 git-sidecar 引擎。
> 次参考：`D:\Projects\Code-cli\kimi-code`（`packages/agent-core`）——hook 角色分离、错误模型理念。

## 3.1 opencode snapshot 全景

opencode 的 snapshot 是一个 ~780 行的 Effect 服务，核心是**旁路 git 仓库**：`--git-dir` 在数据目录、`--work-tree` 指向真实工作区。我们移植其命令编排，去掉 Effect 包装，落到 ohbaby 的 `GitSnapshotEngine`。

### 接口对照

| opencode `Interface`（`index.ts:47-56`） | ohbaby `DiffEngine`（新） | 说明 |
|---|---|---|
| `init()` | engine 惰性 `init` | 首次创建 sidecar gitdir |
| `track()` → tree hash | `recordBaseline()` → commit SHA | 我们用 commit-tree+ref 取代裸 write-tree |
| `restore(snapshot)` | `restoreTo(workdir, commit)` | read-tree + checkout-index |
| `diff(hash)` / `diffFull(from,to)` | `computeDiff` / `diffBetween` | name-status 解析 |
| `revert(patches)` | （restore 覆盖，可选保留） | 逐文件 checkout 兜底 |
| `cleanup()` → `git gc` | `gc()` | 按龄 prune |

## 3.2 直接移植的实现要点

### 要点 1：git 配置前缀（`index.ts:36-38`）

```
core  = ["-c","core.longpaths=true","-c","core.symlinks=true"]
cfg   = ["-c","core.autocrlf=false", ...core]
quote = [...cfg, "-c","core.quotepath=false"]
```

**为何重要（尤其 Windows）**：
- `core.autocrlf=false`：禁止换行符转换，保证 snapshot 字节级一致，diff 不被 CRLF 污染。
- `core.longpaths=true`：突破 Windows 260 字符路径限制。
- `core.symlinks=true` / `core.quotepath=false`：符号链接与非 ASCII 路径正确处理。

ohbaby 运行于 win32，这套配置是正确性前提，必须照搬。

### 要点 2：sidecar 初始化（`index.ts:293-316`）

```
exists(gitdir) ? 跳过 : git init (GIT_DIR/GIT_WORK_TREE env) + 上述 config + core.fsmonitor=false
```

惰性初始化：只在首次 track 时建 gitdir。`core.fsmonitor=false` 避免后台文件监控副作用。

### 要点 3：add + .gitignore 尊重（`index.ts:161-273`）

opencode 的 `add()` 做了三件事，我们按需简化：
1. `sync()`：把源仓库 `info/exclude` 同步进 sidecar，并把超限大文件追加排除（`index.ts:197-208,252-270`）。
2. 列文件：`diff-files`（已跟踪改动）+ `ls-files --others --exclude-standard`（未跟踪）（`index.ts:210-235`）。`--exclude-standard` 即原生尊重工作区 `.gitignore`。
3. `check-ignore --no-index --stdin -z`（`index.ts:124-145`）：对候选集再过一遍忽略规则，把新近被 ignore 的文件从 snapshot index 移除（`drop`，`index.ts:147-159,242-247`）。

> **ohbaby 取舍（满足"读 .gitignore"决策）**：首版可用最简 `git add --all .`——git 默认就尊重工作区内 `.gitignore`（exclude-standard 语义）。opencode 的大文件排除（`limit = 2MB`，`index.ts:35,252-270`）与 `check-ignore` 二次过滤作为 P1 增强项移植，避免把大二进制塞进对象库。

### 要点 4：捕获树 write-tree（`index.ts:309-313`）

```
yield* add()
hash = git args(["write-tree"])   # 暂存区 → tree 对象，返回 hash
```

**ohbaby 差异（关键）**：opencode 返回裸 tree hash（不可达对象，靠 prune 兜底）。ohbaby 的 checkpoint 要持久可恢复，故在 write-tree 后 `commit-tree` 成 commit 并 `update-ref refs/snapshots/<checkpointId>`，让对象可达、不被 gc 误删，删 ref 时才回收。这是我们对 opencode 的**有意改良**。

### 要点 5：restore（`index.ts:351-375`）+ revert 的删除语义（`index.ts:377-490`）

```
git [core] args(["read-tree", snapshot])
git [core] args(["checkout-index", "-a", "-f"])
```

整棵树还原，比 ohbaby 现状"逆向应用 patch 链"更简单。**但有坑**：`checkout-index -a -f` 只写 tree 中的文件，**不会删除**"工作区有、snapshot 没有"的新增文件——opencode 自己的 `restore` 同样不删，删除逻辑在 `revert()` 里显式 `remove()`（`index.ts:407-408,480-484`）。

> **ohbaby 必须补删除**（否则 restore 后工作区 ≠ checkpoint 态，违反验收 UT-GE-05）：用 `read-tree -u --reset <commit>`（更新工作区并删除目标树中已不存在的文件），或 `checkout-index` 后用 `diff --name-only --diff-filter=D <commit>` 枚举多余文件逐个删。见 `02` §2.3.1 restoreTo。

### 要点 6：diffFull 的 name-status + numstat（`index.ts:512-726`）

opencode 用 `diff --name-status` 定状态、`diff --numstat` 取增删行数、`cat-file --batch` 批量取内容（`index.ts:554-649`，并带逐文件 `git show` 兜底）。

> **ohbaby 取舍**：本轮 `FileDiff` 只需 `path + status`（与现有 `types.ts:39-43` 一致），用 `--name-status` 即可，**不需要** numstat/cat-file 的行级内容。行级 hunk（`DiffHunk`）作为未来 TUI 展示再上。

### 要点 7：gc（`index.ts:275-291,728-736`）

```
git args(["gc", `--prune=${prune}`])   # prune = "7.days"
# opencode 用 Schedule.spaced(1h) + delay(1min) 后台循环
```

ohbaby 本轮只暴露 `gc()` 方法 + 删 checkpoint 时 `dropRef`，定时触发留给上层。

### 要点 8：单仓库串行锁（`index.ts:70-80,180`）

opencode 用 `Map<gitdir, Semaphore>` + `locked()` 包裹所有写操作，防止同一 sidecar 的 git 命令交错。ohbaby `GitSnapshotEngine` 照做（`Map<gitdir, Promise>` 链式互斥），与 service 层 `captureLocks` 正交叠加。

### 要点 9：git 命令失败不抛、降级（`index.ts:115-122,170-175,223-231`）

opencode 的 `git()` 把异常转成 `{ code:1, stderr }`，调用方按 code 判断并 `log.warn` 后继续。**ohbaby 对齐**：snapshot 作为 observer，git 失败记录事件不阻断 run（见 `02` P0-2 / 无 git 降级）。

## 3.3 kimi-code 仍然适用的理念（次要）

### 理念 1：观察者钩子 vs 控制钩子分离（`loop/turn-step.ts`）

kimi 明确区分：控制钩子（beforeStep）异常→抛出阻断；观察者钩子（afterStep）异常→吞掉不影响主流程。snapshot 是观察者，故 `worker.ts` 静默可接受，**但应发布可观测事件**（P0-2 的依据）。

### 理念 2：错误模型——不立即合并

kimi 用单 `KimiError` + code 字符串注册表（跨进程序列化友好）。**对 snapshot 的结论**：当前 snapshot 错误仅进程内 `try/catch`（`worker.ts:402` 捕获），不跨序列化边界，**保持 1 基类 + 子类层次**即可。未来若 snapshot 事件需经 RPC/事件总线跨进程发布，再引入 code 注册表。本轮不动。

### 理念 3：模块边界 docblock（`loop/index.ts`）

在 `snapshot/index.ts` 顶部加依赖规则声明：

```typescript
/**
 * Snapshot module — workspace file change tracking via a sidecar git repo.
 *
 * Dependency rule: may import from ../services/ (database), ../runtime/ (types only),
 * ../project/ (project id). Must not import from ../agents/, ../core/, ../commands/,
 * or ../adapters/. The git engine shells out to the `git` binary on PATH.
 */
```

### 理念 4（存档，不采用）：原子写入

kimi 的 `atomicWrite`（tmp+fsync+rename）与 ohbaby 现有 `atomic-writer.ts` 同理。但本轮 base64 artifact 落盘体系整体移除（git 接管），该理念仅作存档。

## 3.4 不借鉴的部分

| 模式 | 不采用的原因 |
|------|--------------|
| opencode 的 Effect 运行时 / Layer / Stream | ohbaby 不用 Effect，移植时去包装为 async/await |
| opencode `cat-file --batch` 行级内容提取 | 本轮 FileDiff 只需 path+status，不取行级内容 |
| opencode `vcs !== "git"` 才启用 | opencode 仅快照 git 项目；ohbaby 用 sidecar 可快照任意目录（只要有 git 二进制） |
| kimi 5 级 hook 系统 | snapshot 只需 pre-run/post-run 两级，YAGNI |
| kimi `code` 注册表错误模型 | snapshot 错误不跨序列化边界，暂不需要 |

## 3.5 关键洞察汇总

| 洞察 | 来源 | 应用 |
|------|------|------|
| 旁路 git-dir + 真实 work-tree 可快照任意目录 | opencode `index.ts:81-90` | GitSnapshotEngine 核心 |
| snapshot = commit + ref（而非裸 tree） | 对 opencode 的改良 | 持久可恢复 + 精确 gc 生命周期 |
| Windows git 配置前缀 | opencode `index.ts:36-38,303-306` | 正确性前提，照搬 |
| `--exclude-standard` 原生尊重 .gitignore | opencode `index.ts:217` | 替代硬编码排除列表 |
| read-tree + checkout-index 原子还原 | opencode `index.ts:355-357` | 取代逆向 patch 链 |
| git gc 即 mark-sweep GC | opencode `index.ts:280` | 删 ref + gc 回收 |
| 单 gitdir 串行锁 | opencode `index.ts:70-80,180` | engine 内互斥 |
| git 失败降级不抛 | opencode `index.ts:115-122` | observer 语义，记录事件不阻断 |
| 观察者钩子异常应记录事件 | kimi `loop/turn-step.ts` | P0-2 |
| 错误模型暂不合并 code 注册表 | kimi `errors/` | 保持现状 |
| 模块边界 docblock | kimi `loop/index.ts` | `snapshot/index.ts` |
