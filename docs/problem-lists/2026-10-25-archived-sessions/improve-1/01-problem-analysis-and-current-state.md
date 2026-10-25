# 1. 现状与问题分析

> 时间口径：分支 `codex/redesign`，提交 `00911105`，2026-10-25，workspace-naming 尚未实施。下文行号是这一版的快照，字段仍是旧名字（`projectDirectory`、`projectRoot`、`pendingProjectRoot`）；实施时按 workspace-naming 的改名对照表换成新名字。路径相对仓库根目录。

## 1.1 问题陈述

1. **归档以后找不回来。** 后端只有归档接口，没有列出已归档会话、恢复、永久删除的接口；Web 也没有入口。
2. **运行中的会话可以被归档，任务却不停。** 停止任务的清理只挂在“会话被删除”事件上，归档不会触发；排队的消息也停在原状态。
3. **永久删除的代码从未被调用，而且删不干净。** 只删直接子会话，孙子会话会变成孤儿；有 3 张表引用会话 ID 却没有外键级联。
4. **设计文档主动排除了这个功能。** Web 重设计把“归档列表的浏览界面”列为不做，把设置限定为 5 个分区，并以“没有取消归档接口”为由不提供 Undo。

## 1.2 已确认的分界

决定见 [00 §2](00-discussion.md)。归档仍是“移出工作集”，只针对根会话；恢复和删除是新增能力。

## 1.3 后端：归档链路

### 调用链

| 层 | 位置 |
|---|---|
| REST | `packages/ohbaby-server/src/protocols/web/routes/sessions.ts:228-255`：`PATCH /v1/sessions/:id/archive`，校验身份后调用 `commandBackend("server-rest").archiveSession`，错误经 `mutationErrorStatus` 映射；OpenAPI 在 `app/openapi.ts:1058` |
| JSON-RPC | 方法 `archiveSession`：`protocols/jsonrpc/protocol.ts:34`、`rpc-route.ts:538`、`client.ts:516` |
| SDK | `packages/ohbaby-sdk/src/contract/client.ts:97` 的 `UiArchiveSessionInput`，`:211` 的方法 |
| 命令网关 | `packages/ohbaby-agent/src/host/ui-command-gateway.ts:40,113`、`command-record.ts:12,196` |
| 实现 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts:2880-2924` 的 `archiveSessionInternal`；`ui-persistent.ts:529` 只是转发 |

`archiveSessionInternal` 做的事：拒绝子代理会话（`:2895`）；`sessionManager.update(id, { status: "archived" })`（`:2899`）；清理提示缓存和内存里的目标、待办、投影缓存（`:2901-2905`）；如果归档的是当前会话，选同一目录下最新的活跃会话（`:2907-2921`）；发布 `session.index.invalidated`（`:2923`）。

`SessionManager.update`（`services/session/manager.ts:220-236`）把 `updated_at` 写成当前时间，并发布 `SessionEvent.Updated`。

### 归档时各种状态的处理

| 状态 | 现在的行为 | 问题 |
|---|---|---|
| 正在运行 | 不停止。停止任务、中断子代理、关闭 shell 和沙箱的清理只挂在 `SessionEvent.Removed` 上（`adapters/ui-runtime/composition.ts:960-994`） | 任务在“看不见”的会话里继续跑 |
| 后台子代理 | 子会话里的子代理可以在后台继续跑（`agents/subagent-host.ts:441`），根会话的运行账本里看不到 | 只查根会话会漏掉 |
| 排队的消息 | 不取消，`prompt_submission` 保持原状态；之后发消息、切换会话都会失败，因为会话索引只列活跃会话（`ui-state/persistent-store.ts:545-553`） | 排队消息悬空 |
| 待切换目录 | 保留；归档后再移动会返回 `SESSION_ARCHIVED`（`services/session/project-move.ts:102-106`，HTTP 409） | 无 |
| 活跃目标 | 只清内存缓存，`goal_record` 保留，目标不暂停 | 依赖“不能运行”来保证不续跑 |
| 子代理会话 | 不归档，仍是 `active` | 全局列表本来就不显示子会话，影响不大 |

判断“正在运行”可以用运行账本：`runtime/run-ledger/types.ts:104` 的 `getActiveRuns(sessionId)` 查数据库，跨进程有效；`run-ledger/errors.ts:25` 已有 `SessionRunBusyError`。

### 哪些地方排除了已归档会话

| 读取方 | 过滤条件 |
|---|---|
| `listGlobalSessions` | `parent_id IS NULL AND status = 'active'`，并排除隐藏工作区（`services/session/global-query.ts:111-113,128-130`） |
| `searchGlobalSessions` | `status = 'active'`（`:265`） |
| `GET /v1/sessions` | 只接受 `limit`、`cursor`（`packages/ohbaby-server/src/runtime/daemon/server.ts:660-672`）；搜索另有 `q`（`:674`） |
| TUI `/sessions` 选择器 | `listByProjectRoot(..., { status: "active" })`（`ui-inprocess.ts:2726-2736`） |
| `getRecent` | 不过滤状态（`database-store.ts:587-592`），但生产代码没有调用方 |

没有任何地方能列出已归档会话，也没有任何取消归档的代码。`UiGlobalSession.status` 类型上有 `"archived"`（`packages/ohbaby-sdk/src/contract/global-sessions.ts:14`），但实际上永远是 `"active"`。

`listKnownSessionProjectRoots`（`database-store.ts:52-75`）不过滤状态，`GET /v1/scopes` 用它自动发现工作区，所以只剩已归档会话的文件夹仍会被自动加回侧栏。这是现有行为，本轮不改，登记在 02 §2.8。

## 1.4 后端：永久删除

### 现有代码

`SessionManager.remove(sessionId, { cascadeChildren })`（`manager.ts:275-329`）在一个事务里：清消息、从父会话的 `childrenIds` 里移除、删会话行；提交后对父会话发布 `Updated`，对每个被删的 ID 发布 `Removed`。`cascadeChildren` 只处理直接子会话（`:285`），孙子会话会被留下。

生产代码没有任何调用方，只有 `manager.unit.test.ts` 用到。

外键已开启：`PRAGMA foreign_keys = ON`（`services/database/index.ts:126`）。

### 数据库里的级联情况

会随会话删除自动级联的表：`message`、`part`（经 `message`）、`run_ledger`、`snapshot_checkpoint`、`snapshot_patch`（经 checkpoint）、`subagent_instance.session_id`、`prompt_submission`、`prompt_resubmission`、`current_run_input`、`current_run_request_owner`（`services/database/migrations.ts` 各处）。`app_state` 没有按会话写入的数据。

一个细节：`current_run_input.run_id` 引用 `run_ledger(run_id)` 时没有写 `ON DELETE`（`migrations.ts:454`）。删除会话之所以能成功，是因为这两张表都从 `session` 级联，在同一条语句里一起删掉。测试要覆盖这一点。

保存了会话 ID 但**没有外键**的列，删除后会留下孤儿数据：

| 列 | 位置 |
|---|---|
| `session.parent_id` | `migrations.ts:12`，自引用，无外键 |
| `goal_record.session_id` | `:186` |
| `subagent_instance.parent_session_id` | `:201` |
| `subagent_execution.parent_session_id`、`root_session_id`、`child_session_id` | `:393,396,405` |

### 磁盘上的文件

| 文件 | 位置 | 删除时是否清理 |
|---|---|---|
| 子代理结果文件 | `<结果存储根>/subagent-results/<parentSessionId>/...`（`agents/subagents/result-artifacts.ts:48-53,170`）。目录按**发起子代理的那个会话**分：嵌套子代理的文件放在子会话的 ID 下。存储根来自 `options.resultStorageRoot` 或 `OHBABY_STORAGE_ROOT`（`adapters/ui-runtime/composition.ts:334`、`services/storage/path-resolver.ts:7-12`） | 会：`SessionEvent.Removed` 触发 `deleteSession`（`:271`，挂在 `composition.ts:963`） |
| 快照 git 引用 | `<快照根>/snapshot-git/<hash>/` 下的 `refs/snapshots/<checkpointId>/{pre,post}`（`snapshot/diff-engine.ts:80-86,299`）。快照根由 `adapters/ui-persistent.ts:203-204` 按存储根算出 | 不会。`SnapshotService.deleteCheckpoint`（`snapshot/service.ts:208`）和 `gc`（`:234`）都没有生产调用方。sidecar 按工作目录共享，只能删引用，不能删目录。另外，删引用的 `dropRef`（`diff-engine.ts:229`）执行 git 时把工作目录当作 `cwd`（`:432-437`），工作目录已被删除时会直接失败 |
| `snapshot_patch.artifact_path` | 列存在 | 从未写入，不涉及 |
| 日志、导出文件 | 按进程或由用户保存 | 不属于会话，不清理 |

## 1.5 Web

### 现有归档交互

| 项 | 现状 |
|---|---|
| 入口 | 会话菜单的 Archive（`apps/ohbaby-web/src/ui/sidebar/SessionMenu.tsx:202-211`，快捷键 `a`）和行上的悬停按钮（`SessionRow.tsx:193-202`） |
| 确认 | 不弹确认（`redesign-2026-10/04-interaction-and-states.md:171`） |
| 运行时 | `runtime/index.ts:259-287`：先从目录里乐观移除，失败时用 `catalog.upsertSession(row)` 放回；成功后 `global.refresh()`；归档的是当前会话时回到草稿 |
| 焦点 | `SessionList.tsx:57-148`：焦点移到下一行；同时取消置顶 |
| 撤销 | 没有。04:69 写明“服务端没有取消归档的接口，所以不提供 Undo” |
| 事件 | `api/daemon/client-sync.ts:673` 监听 `session.archived`，但服务端从不发布这个事件 |

Web 知道每个会话的活动状态（`SidebarSessionItem.activity`：`idle`、`running`、`awaiting`），可以据此禁用归档按钮。

### 设置对话框

| 项 | 现状 |
|---|---|
| 分区注册 | `ui/settings/sections.ts:1,8-12`：`models`、`mcp`、`skills`、`search`、`about`，注释引用 D12 |
| 渲染 | `SettingsDialog.tsx:162-180` 的 `Section()` 按分区 `case` 渲染，只挂载当前分区 |
| 手机宽度 | `settings.css:431-475`：小于 640px 全屏，导航和内容分两屏 |
| 数据加载 | `useSettingsResource`（`useSettingsResource.ts:15-39`）只支持 `store/settings-cache.ts:11-21` 里固定的几类资源；已归档会话是分页列表，需要自己的加载逻辑 |
| 可复用组件 | `SectionFrame.tsx` 的 `SectionHeader`、`SectionStatus`（加载、错误重试、空状态）；`ui/shared/SettingsRow.tsx`（标签、说明、右侧控件）；`ui/shared/ConfirmDialog.tsx`（`danger`、`busy`、`error`，焦点默认在 Cancel）；`ModelsSection.tsx:140-158,355-368` 的删除确认写法；`ui/sidebar/relative-time.ts` 的 `relativeTime`；`ui/workspace/workspace-labels.ts` 的 `workspaceLabel` |

### 恢复后会话重新出现

`store/global-catalog.ts:109` 的 `upsertSession` 会按 `updatedAt` 倒序插回会话。`runtime/global-layer.ts:161-170` 的 `moveSession`（调接口 → `upsertSession` → `refresh`）可以直接照抄。D7 让恢复时更新 `updated_at`，所以恢复的会话排在最前面，不会落在未加载的分页里。

### mock 与测试辅助

- `dev/mock-runtime.ts:198-202` 归档时直接删掉行，没有保留 `status: "archived"` 的数据；`mock-scenarios.ts` 没有已归档会话的场景。
- `runtime/fake-daemon.test-support.ts:374-382` 只标记 `archived = true` 并在列表里过滤，没有恢复和删除。

## 1.6 设计文档与实现对照

| 文档说 | 本议题之后 |
|---|---|
| `redesign-2026-10/00-goal-duty.md:69`：不做“归档列表的浏览界面” | 做，在 Settings 里 |
| `01-use-cases-and-user-flows.md:157,271`、`README.md:22`（D12）：设置只有 5 个分区 | 6 个分区，新增 Archived |
| `04-interaction-and-states.md:69`：没有取消归档接口，所以不提供 Undo | 有接口了，但仍不提供 Undo；恢复入口在 Settings（D10） |
| `04:171`：归档不弹确认，在 Web 上无法撤销 | 仍不弹确认；可以在 Settings › Archived 恢复 |
| `04:52`：已打开的已归档会话在标题旁显示 `Archived`、不能发送 | 实际没有实现；本轮不做，归档后主区回到草稿态，这种状态不会出现在正常流程里 |
| `docs/ohbaby-web/session-archive/README.md`：恢复、列表、永久删除留给以后 | 本议题实现 |

## 1.7 改动影响面

| 层 | 涉及 | 风险 |
|---|---|---|
| 核心会话 | 归档前检查、恢复、递归删除、孤儿表清理 | 删除不可逆；事务里漏删表 |
| 运行时 | 删除后的快照引用清理 | 引用清理失败不能影响删除结果 |
| 服务端与 SDK | 3 个接口、REST 和 JSON-RPC 两条路径 | 删除接口必须拒绝未归档会话 |
| Web | 新分区、归档按钮禁用、mock | 设置对话框里出现分页列表 |
| 文档 | 重设计 00、01、04、README | 与已有决策冲突，需要显式修改 |

## 1.8 SWE 原则审视

- **不变量要放在离数据最近的地方**（02 基础受力）。“只能删除已归档的会话”和“运行中不能归档”写在核心会话层，REST、JSON-RPC、未来的 TUI 都自动遵守，界面只是提前提示。
- **不可逆操作要完整、原子**（00 哲学）。删除在一个事务里完成所有数据库行；文件清理放在事务之后、尽力而为，因为文件系统不能参与回滚。
- **复用已有机制，不新造**（03 DRY、KISS）。列表复用 `GET /v1/sessions` 的分页；恢复复用移动会话的全局路由结构；删除后的文件清理复用快照和结果文件已有的路径规则；归档时间复用 `updated_at`。删除本身不复用 `SessionManager.remove`：它挂在实例上、只删一层子会话，而全局删除不经过实例（理由见 02 §2.2）。
- **不为想象的需求加功能**（03 YAGNI）。一键删除全部、搜索、按工作区分组都等真实需求出现再说。

## 1.9 与既有文档的关系

| 文档 | 关系 |
|---|---|
| [workspace-naming improve-1](../../2026-10-25-workspace-naming/improve-1/02-optimization-plan-and-change-scope.md) | 前置；本议题使用其新名字 |
| `docs/ohbaby-web/session-archive/` | 第一版归档设计，历史记录，不回改 |
| `docs/ohbaby-web/redesign-2026-10/00`、`01`、`04`、`README.md` | Stage 4 同步 |
| `docs/ohbaby-web/redesign-2026-10/improve-4/` | Settings 对话框的实施记录，历史记录，不回改 |
