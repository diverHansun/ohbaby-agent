# architecture

> 2026-11-04。以 [goals-duty](goals-duty.md) 为前提。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`，`W/` = `apps/ohbaby-web/src/`。

## 1. Architecture Overview

本模块很薄：一个“算归属、算路径、建目录”的函数，加上四个接入点。它本身不保存任何状态，目录就是全部的“数据”。

```
工具请求的会话 ──► 归属会话 id ──► ~/.ohbaby/sessions/<ownerId>/      只读（session-storage）
  子代理  → 根会话 id                ├─ scratch/       agent 写的临时文件与产物，可写（session-scratch）
  side chat → 主会话 id              ├─ subagents/     子代理的长报告（子代理结果搬迁议题）
  其他    → 自己的 id                └─ tool-results/  超长工具输出（第二期）
         │
         ├─ sandbox 创建上下文时：注入的回调建目录 + 登记两档可信路径
         ├─ 环境提醒：写明 scratch 路径（可选的一行）
         ├─ 会话永久删除后：cleanupDeletedSessionFiles 删除 sessions/<id>
         └─ 第二期：截断输出的工具存盘；服务端列文件、读文件
```

### 1.1 归属

- 一个父会话下的所有子代理共用一个子会话，彼此只靠 `contextScopeId` 区分（`A/agents/subagent-host.ts:1386-1400`），run 也是用这个子会话 ID 申请 sandbox（`A/runtime/run-manager/manager.ts:400-404`）。如果按会话 ID 分目录，兄弟子代理会共用一个目录，父会话读子代理写的报告也要弹确认。
- 存储区按归属会话分：子代理用它所属的根会话的目录。
- side chat 是隐藏的根会话，用途就是问主会话的事，所以它用 `data.sideChat.mainSessionId` 指向的主会话的目录。
- fork 出来的会话是独立的根会话，用自己的目录。

参考：claude-code 的 scratchpad 按主会话分，主会话和它的子代理共享（`claude-code/src/utils/permissions/filesystem.ts:384`）。

### 1.2 接入点

1. **sandbox**：sandbox 上下文按 `(sessionId, contextScopeId)` 创建，在一轮运行第一次申请时懒创建（`A/adapters/ui-runtime/host-local-environment.ts:208-215`），换运行目录、释放子代理作用域、daemon 重启后都会重建。`SandboxManager` 是通用组件，不应直接知道 `OHBABY_HOME`。做法是给 `SandboxManagerOptions` 加一个注入的回调 `initialTrustedRoots(scope)`，在 `TrustedRootRegistry.create` 处调用（`A/sandbox/manager.ts:123`）。回调由 `composition.ts` 提供。它只拿到 sandbox 作用域（`sessionId`、`contextScopeId`），拿不到工具请求，所以用 `sessionManager.get(scope.sessionId)` 查会话来定归属：有 `parentId`（子代理会话）就用 `parentId`；是 side chat 就用 `data.sideChat.mainSessionId`；否则用自己。子代理不能再创建子代理（`agent` 工具对子代理禁用，`A/core/tool-scheduler/constants.ts:30`），所以一层就够。然后建目录，返回两条：`{ kind: "session-storage", path: 会话目录 }`（只读）和 `{ kind: "session-scratch", path: 会话目录/scratch }`（可写）。`authorizeInternalRead` 就是这样注入的（`composition.ts:472-476`），有先例。每次重建上下文都会重新登记。
2. **环境提醒**：`A/services/reminder/environment.ts` 在现有几行之后加一行 scratch 路径。提醒上下文里已有 `sessionId`（`A/services/reminder/index.ts:18`），按上面同样的规则算出归属 ID。算路径失败时只省略这一行：提醒的收集器遇到异常会丢掉整条提醒（:110-117），连运行目录和日期都没了。
3. **删除**：`A/services/session/archive-files.ts` 的 `cleanupDeletedSessionFiles` 已经在删除快照引用和子代理结果目录，加一个依赖 `sessionStorageRoot`（照 `resultStorageRoot` 的写法，:9-13），在同一个循环里删 `sessions/<id>`。`result.sessionIds` 是整棵会话树（`A/services/session/archive.ts:101-104`），里面有根会话 ID；子会话 ID 没有目录，`rm -f` 不报错。
4. **第二期**：截断输出的工具调用存盘函数；服务端加两个只读路由；Web 右侧面板加 Files 页。

## 2. Design Pattern & Rationale

- **路径由 ID 算出，不入库。** 一个归属会话的存储区永远是 `<OHBABY_HOME>/sessions/<id>`。不需要表、不需要迁移，删库删目录各管各的。对应目标 5。
- **按根会话分，不按工作区分。** 会话可以在工作区之间移动，按工作区分就得搬目录；子代理和 side chat 是在替主会话干活，和主会话共用目录最自然。对应目标 1、4。
- **授权走现有的可信路径机制，分两档。** 现有机制里，读取的可信判断接受任何类型（`A/sandbox/lease.ts:90-92`、`scheduler.ts:196`），写入只认 `isWriteTrustedRootKind` 列出的类型（`A/core/tool-scheduler/scheduler.ts:202-219`），不在其中的路径按外部写入走确认。所以分两档只要三处改动：
  1. `TrustedRootKind` 加 `"session-storage"` 和 `"session-scratch"`（`A/sandbox/trusted-roots.ts:5-10`）。
  2. `isWriteTrustedRootKind` 只加 `session-scratch`。整个会话目录登记成 `session-storage`，读不弹确认；写 `subagents/`、`tool-results/` 时按外部写入弹确认。
  3. Bash 的路径预检现在不分类型，把所有可信路径都当作可访问（`A/tools/bash.ts:141-145`、`A/sandbox/preflight.ts:88-93`）。在 `trusted-roots.ts` 加一个判断 `isShellTrustedRootKind(kind)`（`session-storage` 返回 false），在传给预检的地方先按它过滤：`bash.ts:141-145`（目前唯一实际调用预检的地方）和 `lease.preflight`（`lease.ts:121-128`，现在没有生产调用方，一起改以免以后漏掉）。**不要改 `lease.ts:21-23` 的 `trustedRootPaths()`**：它还被 `assertTrustedLexical` 用来判断读路径（`lease.ts:41`，`A/tools/file-access.ts:40-41`、`:73` 经 `resolvePath` 调到），在那里过滤会让读 `session-storage` 的路径直接报越界。Bash 访问 `scratch/` 仍然免确认（`session-scratch` 那一条还在）；访问会话目录的其余部分按外部路径确认。Bash 分不清读和写，所以连读也要确认，模型应改用 `read`。

  唯一的 sandbox 适配器是 `A/sandbox/adapters/host-local.ts`，没有操作系统级的沙箱配置会挡住写入。对应目标 3。
- **为什么系统文件只读。** `subagents/` 和 `tool-results/` 里的文件，父代理会当成可信的原始记录来读。假如某个子代理读了藏有恶意指令的网页，被诱导去改写兄弟子代理的报告，父代理读到的就是假报告。参考项目没有一家让模型写这类文件：claude-code 只让 scratchpad 和计划文件免确认可写；minimax 对 `tool-outputs` 等只给只读授权；dsh 的设计笔记写明超长输出文件是“运行时产物，不是模型写的工作区文件”。
- **上下文创建时建目录。** Bash 往不存在的目录里写会直接失败，所以不等到第一次写入再建。会话不运行就不会创建上下文，从没运行过的会话不会留下空目录。先建目录再登记可信路径：登记时要解析真实路径，目录已存在才能解析到最终位置（例如 macOS 上 `/var` 实际指向 `/private/var`），这样登记的路径和工具实际访问的路径才对得上。
- **三个子目录，两档权限。** `scratch/` 给 agent，`subagents/` 和 `tool-results/` 给系统，一种内容一个名字明确的文件夹，参考项目都这样分（kimi-code 的 `tasks/`、`tool-results/`、`plans/`，claude-code 的 `subagents/`、`tool-results/`）。权限只有两档，不按文件夹逐个登记。第一期只建 `scratch/`；`subagents/` 由子代理结果搬迁议题在第一次导出时创建，`tool-results/` 由第二期在第一次写入时创建。

## 3. Module Structure & File Layout

| 文件 | 内容 |
|---|---|
| `A/paths/session-storage.ts`（新） | `resolveSessionStorageDir(ownerSessionId, options?: OhbabyPathOptions)`、子目录名常量 `SCRATCH_DIR`、`TOOL_RESULTS_DIR`、`ensureSessionStorage(ownerSessionId, options?)`；校验 ID。写法照 `A/paths/default-directory.ts:24-33` 的 `ensureDefaultDirectory` |
| `A/sandbox/trusted-roots.ts` | `TrustedRootKind` 加 `"session-storage"`、`"session-scratch"`；新增 `isShellTrustedRootKind` |
| `A/sandbox/lease.ts`（只改 `preflight`）、`A/tools/bash.ts` | 传给 Bash 预检的可信路径按 `isShellTrustedRootKind` 过滤；`trustedRootPaths()` 不动 |
| `A/sandbox/manager.ts` | `SandboxManagerOptions` 加 `initialTrustedRoots`，创建上下文时调用 |
| `A/core/tool-scheduler/scheduler.ts` | `isWriteTrustedRootKind` 加 `session-scratch` |
| `A/adapters/ui-runtime/composition.ts` | 提供 `initialTrustedRoots` 回调；算归属 ID（子代理 → 根会话，side chat → 主会话） |
| `A/services/reminder/{index,environment}.ts` | 提醒上下文带归属 ID；环境提醒加可选的一行 |
| `A/services/session/archive-files.ts` | 删除 `sessions/<id>` |
| 第二期新增 | `A/services/session-storage.ts`：`writeToolOutput`、`listSessionFiles`、`readSessionFile` |
| 第二期修改 | `A/tools/utils/output.ts` 与调用方、`A/tools/glob.ts`、`A/tools/web.ts`、`A/tools/bash.ts`、`S/protocols/web/routes/sessions.ts`、`W/ui/side-panel/`；新建 `W/ui/session-files/` |

## 4. Architectural Constraints & Trade-offs

### 4.1 约束

| 约束 | 做法 |
|---|---|
| id 不能造成路径穿越 | 只接受 `[A-Za-z0-9_-]`，长度不超过 128；现有会话 ID（`session_<毫秒>_<base36>`，`A/services/session/id-generator.ts:16`；以及 UUID，`S/app/create-app.ts:139`）都符合 |
| 只有当前用户能读写 | 照 `A/observability/process-logger.ts:253-266`：`mkdir` 带 `mode: 0o700`，非 Windows 再 `chmod`；第二期写的文件 0600。Windows 上不做权限位处理 |
| 尊重 `OHBABY_HOME` | 路径基于 `resolveOhbabyHome()`（`A/paths/ohbaby-home.ts:65`） |
| 第二期读文件不越界 | 只读归属目录 `scratch/` 内的普通文件，真实路径必须仍在其内，拒绝符号链接；单次读取设上限 |
| 敏感文件 | 沿用 sandbox 现有的敏感文件名单，不另设规则 |
| 只读靠调度器落实 | sandbox 层的 `resolvePathForWrite` 接受任何类型的可信路径（`lease.ts:25-34`、`:106-110`），“写入要确认”完全由调度器的写入分类决定（`scheduler.ts:202-232`，按 `file_path`、`filePath`、`path` 参数识别，`:271-279`）。以后新增写工具时要沿用这几个参数名 |

### 4.2 取舍

| 取舍 | 选择 | 代价 |
|---|---|---|
| 放 `~/.ohbaby/` 还是平台数据目录 | `~/.ohbaby/`，用户确认 | 和数据库不在一处，删除要两边各删一次；`cleanupDeletedSessionFiles` 本来就是“提交后清文件”，不增加复杂度 |
| 自动清理 | 不做，只随会话删除 | 很少永久删除会话的用户，磁盘会慢慢变大。以后可以加手动清理，或按时间清理 `tool-results/` |
| side chat 用主会话的目录 | 能直接读主会话的文件 | side chat 写的文件关闭后仍留在主会话那里 |
| fork 用自己的目录 | 不复制、不授权读取源会话 | 历史里提到的源会话文件，读取时要确认 |
| 归档 | 保留文件 | 归档的会话占着磁盘 |
| 权限分两档 | `scratch/` 可写，其余只读 | 用 Bash 读 `subagents/`、`tool-results/` 也要确认（Bash 分不清读写）；模型应改用 `read` 或 `grep`。用户把 `~` 或 `~/.ohbaby` 选作工作区时，运行目录内的写入本来就不确认，只读那一档失效，接受 |

### 4.3 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| 第一期 | 归属与路径、建目录、可信路径、环境提醒、随删除清理 | 无。side chat 的归属分支由本模块第一期和 side chat 议题中后落地的一方接上（见 side chat 02 Stage 1 第 7 步） |
| 第二期 a | 超长工具输出存盘：`web`、`list`（经 `renderList`）、`glob`（经 `truncateIfTooLong`）和 Bash | 第一期 |
| 第二期 b | 服务端列文件、读文件；Web 右侧面板 Files 页 | 第一期 |

第二期 a 与 b 互不依赖。

### 4.4 需要同步的权威文档

| 文档 | 改什么 |
|---|---|
| `docs/sandbox/improve-2/integration-plan.md`（:21-25、:49 列了可信路径类型） | 加 `session-storage`（只读，Bash 预检不认）和 `session-scratch`（可写） |
| `docs/services/session/` 中会话删除的说明 | 删除时多删一个目录 |
| 第二期：`docs/tools/` 中输出截断的说明、`docs/ohbaby-web/` 的右侧面板说明 | 存盘与 Files 页 |
