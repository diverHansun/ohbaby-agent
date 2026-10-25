# 2. 优化方案与改动面

> 本文是交给实施会话的契约。Stage 1、2 由用户实施，Stage 3、4 由 agent 实施。验收标准见 [04](04-test-and-acceptance.md)。路径相对仓库根目录；字段名按 workspace-naming 之后的新名字书写，行号是 `00911105` 的快照。

## 2.1 方案总览

```
侧栏 Archive ──PATCH /v1/sessions/:id/archive──▶ 实例 ── 运行中？拒绝 409 ── 否则 status=archived
                                                    （按目录路由，现有路径，只加检查）

Settings › Archived
  ├─ 列表 ──GET /v1/sessions?status=archived──────▶ daemon 全局路由 ── 查数据库
  ├─ Restore ──POST /v1/sessions/:id/unarchive───▶ daemon 全局路由 ── 核心 restoreArchivedSession
  │                                                    └─ 工作区还在 → 重新显示该工作区
  └─ Delete ──DELETE /v1/sessions/:id────────────▶ daemon 全局路由 ── 核心 deleteArchivedSession
                                                       └─ 事务提交后：清快照引用、子代理结果文件
```

恢复和删除走 daemon 的**全局路由**（和移动会话 `POST /v1/sessions/:sessionId/workspace` 一样），不走按目录路由到实例的路径。原因是已归档会话的文件夹可能已经不存在，无法为它加载实例；而且这两个操作只改数据库，不需要实例。

归档仍走原来的实例路径，只在核心里加一条“运行中不能归档”的检查。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 列表接口 | 现有 `GET /v1/sessions` 加 `status=archived` 参数 | 复用分页和游标 | 新路由 `/v1/sessions/archived` | 列表函数多一个参数 |
| 恢复、删除走哪条路 | daemon 全局路由，核心提供纯数据库函数 | 文件夹不在时无法加载实例；照抄移动会话的结构 | 走实例的命令网关 | 不经过 JSON-RPC，TUI 暂时没有入口（D10 本来就不做） |
| 规则写在哪 | 核心会话层（`services/session/archive.ts`） | 不变量离数据最近，所有入口都遵守 | 只在服务端路由里检查 | 无 |
| 运行中归档 | 核心拒绝，抛 `SessionRunBusyError`，REST 映射为 409 `SESSION_RUNNING`。检查范围包括会话自己的活跃运行和排队消息，以及所有后代会话的活跃运行 | 现在归档不停任务；拒绝最简单、不丢工作；后台子代理在子会话里跑，只查根会话会漏 | 自动停止再归档 | 用户要先点停止 |
| 恢复时目录检查 | 工作区目录按 `resolveWorkspaceScope` 能否解析且等于原路径判断；运行目录按“存在且是目录”判断 | 和 `GET /v1/scopes` 判断 `available` 的方式一致 | 只看路径字符串 | 恢复时多几次文件系统调用 |
| 归档时间 | `updated_at`（D7） | 归档后会话不再运行，基本不变 | 新加 `archived_at` 列 | 少数延迟写入（如标题生成）可能更新它，只影响排序；不为此在核心加只读保护 |
| 删除范围 | 根会话及所有后代，外加 3 张无外键表的相关行，一个事务 | 不留孤儿数据 | 软删除；只删根会话 | 不可恢复 |
| 文件清理 | 事务提交后尽力而为，失败只记日志 | 文件系统不能参与回滚 | 放进事务 | 极端情况下会留下少量文件 |
| 现有 `SessionManager.remove` | 不改、不复用 | 它依赖实例里的 manager，且只删一层子会话；全局删除另写一个数据库函数更直接 | 修它并在全局路由里构造 manager | 代码里暂时有两个删除入口，登记在 2.8 |
| Web 列表 | Settings 第 6 个分区，平铺，按归档时间倒序 | D9 | 按工作区分组 | 无 |

## 2.3 分阶段实施

### Stage 1：核心规则（用户实施）

**目标**：核心层有完整的归档、恢复、删除规则，有测试；对外接口暂时只多了“运行中不能归档”这一条行为变化。

**做法**：

1. **归档前检查（D3）**。`packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 `archiveSessionInternal`（L2880-2924）在 `sessionManager.update` 之前检查，任一条件成立就抛 `SessionRunBusyError`（`runtime/run-ledger/errors.ts:25`，已从包入口导出）：
   - 本进程 `activePromptsBySession`（`:616`）里有这个会话；
   - 运行账本（`sourceLedger`，`:695`）的 `getActiveRuns(id)`（`runtime/run-ledger/types.ts:104`）对会话本身或任一后代会话非空；后代按 `session.parent_id` 递归查出；
   - `prompt_submission` 里有这个会话的排队或启动中的记录。

   运行账本和 `prompt_submission` 都在数据库里，所以别的进程里正在跑的任务也能发现。
2. **新文件 `packages/ohbaby-agent/src/services/session/archive.ts`**，提供两个纯数据库函数，参数里传入 `DatabaseConnection`，写法照抄 `workspace-move.ts`（workspace-naming 之前叫 `project-move.ts`）：

   ```ts
   export type SessionArchiveErrorCode =
     | "SESSION_NOT_FOUND"
     | "SESSION_NOT_ROOT"
     | "SESSION_NOT_ARCHIVED";

   export class SessionArchiveError extends Error { /* code + sessionId */ }

   /** Restores an archived root session; see D4–D7. */
   export function restoreArchivedSession(
     db: DatabaseConnection,
     sessionId: string,
     input: {
       /** Whether the session's workspace folder still resolves to itself. */
       readonly workspaceAvailable: boolean;
       /** Whether pending ?? working directory still exists. */
       readonly nextDirectoryExists: boolean;
       readonly defaultDirectory: string;
       readonly now: number;
     },
   ): Session;

   /** Deletes an archived root session and every descendant in one transaction. */
   export function deleteArchivedSession(
     db: DatabaseConnection,
     sessionId: string,
   ): {
     readonly sessionIds: readonly string[];
     readonly checkpoints: readonly { readonly checkpointId: string; readonly workdir: string }[];
   };
   ```

   目录检查由调用方在事务外异步完成，结果作为布尔值传入，事务里没有 `await`。
3. **恢复规则（D4、D6、D7）**，在一个事务里：
   - 会话不存在 → `SESSION_NOT_FOUND`；有 `parent_id` → `SESSION_NOT_ROOT`；状态不是 `archived` → `SESSION_NOT_ARCHIVED`。
   - `workspace_directory` 有值且 `workspaceAvailable` 为真 → 保留；否则设为 `NULL`。
   - 下一轮目录 = `pending_working_directory ?? working_directory`。它存在时保持原值；不存在时，保留了工作区就把 `pending_working_directory` 设为工作区目录，没保留就设为默认目录。
   - `status = 'active'`，`updated_at = now`。
4. **删除规则（D2、D8）**，在一个事务里：
   - 会话不存在、不是根会话或状态不是 `archived` 时抛对应错误，不删任何东西。
   - 每条语句都用同一个 `WITH RECURSIVE tree(id) AS (... UNION ...)` 按 `session.parent_id` 选出根会话和所有后代，不把 ID 列表绑定成参数（避免超出 SQLite 的参数个数上限；`UNION` 去重，父子成环也不会死循环）。
   - 先读出这些会话的 ID 和快照检查点 `(checkpoint_id, workdir)`，作为返回值。
   - 删除没有外键的行：`goal_record WHERE session_id IN tree`；`subagent_execution WHERE parent_session_id IN tree OR root_session_id IN tree OR child_session_id IN tree`；`subagent_instance WHERE parent_session_id IN tree`。
   - 最后 `DELETE FROM session WHERE id IN tree`，其余表靠外键级联（`current_run_input` 与 `run_ledger` 同时级联，见 01 §1.4）。
5. **导出**：在 `services/session/index.ts` 和包入口 `src/index.ts` 导出 `restoreArchivedSession`、`deleteArchivedSession`、`SessionArchiveError`。
6. **删除后的文件清理函数** `cleanupDeletedSessionFiles(result, deps)`（供 Stage 2 调用）。`deps` 显式传入快照根、结果存储根和日志函数，方便测试注入失败：
   - 快照引用：对每个检查点删除 `refs/snapshots/<checkpointId>/pre` 和 `/post`。sidecar 目录按 `diff-engine.ts:299` 的规则从 `workdir` 算出，执行 git 时只用 `--git-dir=<sidecar>`，**不**把 `workdir` 当作 `cwd`。现有的 `dropRef`（`diff-engine.ts:229`）以工作目录为 `cwd`（`:432-437`），工作目录已删除时会失败，而被删的会话恰恰常常是这种情况。快照根必须和实例用的相同，来源见 `adapters/ui-persistent.ts:203-204`。不能调用 `SnapshotService.deleteCheckpoint`，因为数据库行已经被级联删除。
   - 子代理结果文件：对返回的**每个**会话 ID 删除 `<结果存储根>/subagent-results/<id>/`。结果文件按发起子代理的会话分目录（`result-artifacts.ts:48-53`），嵌套子代理的文件在子会话 ID 下，所以要遍历全部 ID。结果存储根和实例相同（`composition.ts:334`、`path-resolver.ts:7-12`）。不能依赖 `result-artifacts.ts:271` 的 `deleteSession`，因为它要读的 `subagent_execution` 行已经删掉了。
   - 都是尽力而为：每项单独 `try/catch`，失败记日志，不抛出。

**完成定义**：

- `pnpm typecheck`、`pnpm test:unit`、`pnpm test:integration` 通过。
- 04 T1 至 T5 通过。

### Stage 2：服务端与 SDK 接口（用户实施）

**目标**：3 个接口可用，错误码清晰。

**做法**：

1. **列表**：`services/session/global-query.ts` 的 `listGlobalSessions`（L128-130）加 `status?: "active" | "archived"` 选项，默认 `active`。`archived` 时：`status = 'archived'`，仍只列根会话，**不**排除隐藏工作区里的会话（用户要能看到所有已归档会话）。排序和游标不变（按 `updated_at` 倒序）。服务端 `listGlobalSessions` 路由（`packages/ohbaby-server/src/runtime/daemon/server.ts:660-672`）读取 `status` 查询参数，只接受 `active`、`archived`，其他值返回 400，复用已有的 `INVALID_QUERY` 错误码。
2. **恢复**：新路由 `POST /v1/sessions/:sessionId/unarchive`，注册在 `server.ts:300-312` 的全局路由旁边。处理方法照抄 `moveSessionProject`（L689-722，workspace-naming 后叫 `moveSessionWorkspace`）：
   - 用 `resolveWorkspaceScope` 和文件系统检查算出两个目录是否可用，确保默认目录存在（`ensureDefaultDirectory`），再调用核心 `restoreArchivedSession`。
   - 返回的会话有工作区时，调用 `workspaceRegistry.open(workspaceDirectory)`（`workspace-registry/database-store.ts:114-136`，会把隐藏的工作区设为可见），实现 D5。注册表是可选的（`main.ts:541` 的 `createWorkspaceRegistryIfAvailable`），没有注册表时跳过这一步，恢复照常成功。
   - 响应 `{ ok: true, session: UiGlobalSession }`。
3. **删除**：新路由 `DELETE /v1/sessions/:sessionId`。调用核心 `deleteArchivedSession`，提交后调用 Stage 1 第 6 步的清理函数（快照根和结果存储根用实例相同的来源算出），响应 `{ ok: true, deletedSessionIds: string[] }`。
4. **全局目录接口**：`GlobalSessionCatalog`（`coordination/session-project-move.ts:21-24`，workspace-naming 后为 `session-workspace-move.ts`）加 `restore` 和 `delete` 两个方法，由 `runtime/daemon/main.ts:548-556` 接上核心函数，和 `planMove` / `commitMove` 的接法一致。
5. **错误映射**（`protocols/global-sessions.ts` 的 `globalSessionErrorStatus`，L85-110）：`SESSION_NOT_FOUND` → 404 和 `SESSION_NOT_ROOT` → 409 已经存在，直接复用；新增 `SESSION_NOT_ARCHIVED` → 409。
6. **运行中归档**：归档路由现在用 `webErrorBody(message)` 返回错误，没有 `code` 字段（`protocols/web/request-helpers.ts:36`），状态码由 `mutationErrorStatus`（`request-helpers.ts:130-135`）决定，忙碌的会话会得到 400。修改 `protocols/web/routes/sessions.ts:248-252`：错误是 `SessionRunBusyError` 时返回 409 和 `{ error: { code: "SESSION_RUNNING", message } }`。JSON-RPC 的 `archiveSession`（`protocols/jsonrpc/rpc-route.ts:538`）现在原样透传后端错误，在这里同样把 `SessionRunBusyError` 转成带 `SESSION_RUNNING` 的错误数据。
7. **SDK**（`packages/ohbaby-sdk/src/contract/global-sessions.ts`）：导出错误码常量 `SESSION_RUNNING_ERROR_CODE`、`SESSION_NOT_ARCHIVED_ERROR_CODE`，以及 `UiGlobalSessionStatus = "active" | "archived"` 和删除响应类型 `UiSessionDeleteResult { deletedSessionIds }`。恢复复用 `UiGlobalSession`。
8. 服务端测试辅助和 Web 的 `runtime/fake-daemon.test-support.ts`（L374-382）补上这 3 个路由，让 Stage 3 能写测试。

**完成定义**：

- `pnpm typecheck` 和全部测试通过。
- 04 T6 至 T9 通过。

### Stage 3：Web（agent 实施）

**目标**：Settings 里能看到、恢复、删除已归档会话；运行中的会话不能归档。

**做法**：

1. **分区注册**：`apps/ohbaby-web/src/ui/settings/sections.ts` 加 `"archived"`，标签 `Archived`，排在 `Web search` 之后、`About` 之前；`SettingsDialog.tsx:162-180` 的 `Section()` 加对应 `case`。
2. **接口层**：`api/daemon/global-sessions.ts` 加 `listArchivedSessions(cursor?)`、`unarchiveSession(id)`、`deleteSession(id)`。
3. **新组件 `ui/settings/ArchivedSection.tsx`**：
   - 自己管理分页列表（不进 `settings-cache`，因为它是可翻页、会变化的列表），打开分区时加载第一页。
   - 用 `SectionHeader` 和 `SectionStatus`：加载中、出错可重试、空状态文案 `No archived chats`。
   - 每行用 `SettingsRow`：标签是会话标题；说明是 `工作区名 · Archived 3d ago`，没有工作区时是 `No workspace · Archived 3d ago`（`workspaceLabel`、`relativeTime`）；右侧是 `Restore` 按钮和危险样式的 `Delete` 按钮。
   - 还有下一页时在底部显示 `Show more`。
4. **恢复**：调接口 → 从列表移除该行 → `catalog.upsertSession(session)` → `global.refresh()`，写法照抄 `runtime/global-layer.ts:161-170` 的 `moveSession`。不弹提示；焦点移到下一行，没有下一行时移到分区标题。
5. **删除**：`ConfirmDialog`，`title` 为 `Delete this chat permanently?`，`description` 为 `“{title}” and its history will be removed. This can’t be undone.`，`confirmLabel` 为 `Delete`，`danger`，带 `busy` 和 `error`；写法照抄 `ModelsSection.tsx:140-158,355-368`。成功后从列表移除该行。
6. **侧栏**：会话的 `activity` 不是 `idle` 时，`SessionMenu.tsx:202-211` 的 Archive 菜单项和 `SessionRow.tsx:193-202` 的悬停按钮置灰，提示文字 `Stop the chat before archiving`。`activity` 只知道当前已加载实例里的会话，其他工作区的会话默认显示为 `idle`（`store/sidebar-groups.ts:160`），这时靠服务端返回 409，走现有的错误提示。
7. **mock**：`dev/mock-runtime.ts` 归档时保留行并标记 `status: "archived"`（L198-202），列表按状态过滤（L102-105），补上恢复和删除；`dev/mock-scenarios.ts` 新增 `archived` 场景，包含约 8 个已归档会话，其中一个的工作区文件夹不存在。
8. 测试：新增 `ArchivedSection` 单元测试；`Sidebar.unit` 补归档按钮禁用；`SettingsDialog.integration` 补第 6 个分区。

**完成定义**：

- Web 类型检查和测试通过。
- 04 T10 至 T13 通过，包括浏览器走查。

### Stage 4：文档同步（agent 实施）

**目标**：Web 设计文档不再和实现冲突。

**做法**：按 2.9 的 D 行修改：

- `00-goal-duty.md` 的“不做”清单去掉“归档列表的浏览界面”。
- `README.md` 的 D12 和 `01-use-cases-and-user-flows.md` 中“设置只有 5 个分区”改为 6 个，并补一条“恢复或删除已归档会话”的用例。
- `04-interaction-and-states.md` 的 Undo 说明（L69）和“归档在 Web 上无法撤销”（L171）改为“恢复入口在 Settings › Archived，归档时不弹 Undo”；删掉已归档会话显示 `Archived` 标记的描述（L52）；补 Archived 分区的交互、运行中禁用归档。
- `06-data-api-and-state.md` 的接口表补 3 个接口；`05-components.md` 补 `ArchivedSection`。

**完成定义**：04 T14 通过。

## 2.4 按包和目录的改动面

| 包 / 目录 | 新增 | 修改 | 说明 |
|---|---|---|---|
| `packages/ohbaby-agent/src/services/session` | `archive.ts` 及其集成测试 | `index.ts` | Stage 1 |
| `packages/ohbaby-agent/src/adapters` | 无 | `ui-inprocess.ts` | Stage 1，归档前检查 |
| `packages/ohbaby-agent/src`（快照、存储） | 删除后的清理函数（放在 `services/session/archive.ts` 旁，或 snapshot 模块，二选一） | `index.ts` 导出 | Stage 1 |
| `packages/ohbaby-agent/src/services/session/global-query.ts` | 无 | `listGlobalSessions` | Stage 2 |
| `packages/ohbaby-server/src` | 无 | `runtime/daemon/server.ts`、`runtime/daemon/main.ts`、`coordination/session-workspace-move.ts`、`protocols/global-sessions.ts`、`protocols/web/routes/sessions.ts`、JSON-RPC 错误映射 | Stage 2 |
| `packages/ohbaby-sdk/src/contract` | 无 | `global-sessions.ts`、`../index.ts` | Stage 2 |
| `apps/ohbaby-web/src` | `ui/settings/ArchivedSection.tsx` 及测试 | `ui/settings/{sections,SettingsDialog}.tsx`、`api/daemon/global-sessions.ts`、`ui/sidebar/{SessionMenu,SessionRow}.tsx`、`dev/*`、`runtime/fake-daemon.test-support.ts` | Stage 2（测试辅助）、Stage 3 |
| `docs/ohbaby-web/redesign-2026-10` | 无 | `README.md`、`00`、`01`、`04`、`05`、`06` | Stage 4 |

## 2.5 API、协议与兼容

| 接口 | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `GET /v1/sessions?status=archived&limit=&cursor=` | 查询参数 | `{ ok, sessions: UiGlobalSession[], nextCursor? }`，`status` 均为 `archived` | 400 `INVALID_QUERY` |
| `POST /v1/sessions/:sessionId/unarchive` | 无请求体 | `{ ok, session: UiGlobalSession }` | 404 `SESSION_NOT_FOUND`；409 `SESSION_NOT_ROOT`；409 `SESSION_NOT_ARCHIVED` |
| `DELETE /v1/sessions/:sessionId` | 无请求体 | `{ ok, deletedSessionIds: string[] }` | 同上 |
| `PATCH /v1/sessions/:id/archive`（已有） | 不变 | 不变 | 新增 409 `SESSION_RUNNING` |

- 不改数据库结构，不需要迁移。
- 都是新增接口和新增错误码，对已有客户端兼容。唯一的行为变化是运行中的会话不能再归档。
- 恢复和删除只走 REST，不加 JSON-RPC 方法（TUI 不需要，D10）。

## 2.6 风险与回滚

| 风险 | 表现 | 预防 | 回滚 |
|---|---|---|---|
| 删错会话 | 未归档或别人正在用的会话被删 | 核心事务内检查 `status = 'archived'` 和根会话；Web 二次确认；D3 保证已归档会话不在运行 | 无法恢复，靠预防 |
| 删不干净 | 孤儿行或文件残留 | 递归删后代、显式删 3 张无外键表；T4 逐表检查 | 补删即可，不影响功能 |
| 文件清理失败 | 快照引用或结果文件残留 | 尽力而为、记日志 | 无需回滚 |
| 恢复后下一轮目录无效 | 发消息失败 | D6 改到默认目录；T2 | 用户手动移动会话 |
| 恢复后会话看不见 | 工作区被隐藏 | D5 重新显示工作区；T7 | 用户手动打开工作区 |
| 归档检查和任务启动的竞态 | 检查通过后正好有任务开始 | 窗口很小；即使发生，任务仍会照常结束，只是在已归档会话里 | 恢复后可见；不做加锁 |
| 设置里列表很长 | 首屏慢 | 分页，每页沿用服务端默认条数 | 无 |
| 被删的会话正在另一个标签页里打开 | 那个标签页下次请求得到 404 | 不做专门处理，走现有的错误提示；侧栏刷新后该会话消失 | 刷新页面 |
| 后台子代理还在子会话里跑 | 只查根会话会放行归档 | D3 的检查覆盖所有后代会话；T1 | 无 |

## 2.7 与 00 的边界对齐

| 00 中的结论 | 本文落点 |
|---|---|
| D1 接口 | Stage 2 第 1 至 3 步，2.5 |
| D2 只能删除已归档的会话 | Stage 1 第 4 步，Stage 2 第 5 步 |
| D3 运行中不能归档 | Stage 1 第 1 步，Stage 2 第 6 步，Stage 3 第 6 步 |
| D4、D6、D7 恢复规则 | Stage 1 第 3 步 |
| D5 重新显示工作区 | Stage 2 第 2 步 |
| D8 删除范围 | Stage 1 第 4、6 步，Stage 2 第 3 步 |
| D9 Archived 分区 | Stage 3 |
| D10 不做的事 | 2.8 |
| 设计文档修改 | Stage 4 |

## 2.8 不在本轮

| 事项 | 原因 | 去向 |
|---|---|---|
| 一键删除全部、归档列表搜索、按工作区分组 | D10，等真实需求 | 后续候选 |
| 归档后的 Undo 提示 | D10，和“尽量少的通知”冲突 | 不做 |
| TUI 里的恢复和删除入口 | D10 | 后续候选 |
| 子会话单独归档、自动归档 | D10 | 后续候选 |
| `SessionManager.remove` 与新删除函数并存 | 前者只删一层子会话，且没有生产调用方 | 后续候选：删掉旧方法，或让它调用新函数 |
| 删除时通知已加载的实例 | 全局删除不发布 `SessionEvent.Removed`，已加载实例里该会话的上下文管理器、MCP 菜单、shell 任务等内存资源（`composition.ts:960-994`）要等实例卸载或 daemon 重启才释放。归档时已清理目标、待办和投影缓存，剩下的资源量很小 | 后续候选：daemon 删除后通知已加载的实例 |
| 只剩已归档会话的文件夹仍被自动加回侧栏（`listKnownSessionProjectRoots` 不过滤状态） | 现有行为，和本议题无直接关系 | 后续候选 |
| 已打开的已归档会话显示 `Archived` 标记（重设计 04:52） | 正常流程里不会出现 | 不做，Stage 4 删掉该描述 |

## 2.9 关键改动清单

> 行号是 `00911105` 的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号 / 小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | `archiveSessionInternal` | L2880-2924 | 更新状态前检查运行中，抛 `SessionRunBusyError` | D3 的唯一落点 |
| C2 | 代码 | `packages/ohbaby-agent/src/services/session/archive.ts`（新） | `restoreArchivedSession`、`deleteArchivedSession`、`SessionArchiveError` | 新文件 | 恢复与删除规则 | 不可逆删除的核心 |
| C3 | 代码 | `packages/ohbaby-agent/src/snapshot/diff-engine.ts`、`services/storage/path-resolver.ts` | sidecar 路径规则与引用名、`dropRef` 的 git 调用方式、子代理结果路径 | `diff-engine.ts:80-86,229,299,432-437`；`path-resolver.ts:7-12`；`result-artifacts.ts:48-53` | 清理函数复用路径规则，但 git 只用 `--git-dir`、不以工作目录为 `cwd`；结果目录按全部会话 ID 删除 | 工作目录常已被删；清理不能依赖已被级联删除的数据库行 |
| C4 | 代码 | `packages/ohbaby-agent/src/services/session/global-query.ts` | `listGlobalSessions` | L111-113、L128-130 | 加 `status` 选项；已归档时不排除隐藏工作区 | 列表接口的数据来源 |
| C5 | 代码 | `packages/ohbaby-server/src/runtime/daemon/server.ts` | 全局路由表、`listGlobalSessions` 路由、新增恢复与删除处理方法 | L300-312、L660-672、参照 L689-722 | 3 个接口 | 对外契约 |
| C6 | 代码 | `packages/ohbaby-server/src/runtime/daemon/main.ts` | 全局目录接线 | L548-556 | 接上核心的恢复和删除函数 | 服务端与核心的连接点 |
| C7 | 代码 | `packages/ohbaby-server/src/protocols/global-sessions.ts` | `globalSessionErrorStatus` | L85-110 | 新增 `SESSION_NOT_ARCHIVED` → 409，复用已有的 404、409、`INVALID_QUERY` | 错误语义 |
| C8 | 代码 | `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` | 归档路由；`request-helpers.ts` 的 `webErrorBody`、`mutationErrorStatus` | L248-252；`request-helpers.ts:36,130-135` | `SessionRunBusyError` → 409，响应带 `code: "SESSION_RUNNING"` | D3 的对外表现 |
| C9 | 代码 | `apps/ohbaby-web/src/ui/settings/sections.ts`、`SettingsDialog.tsx` | `SettingsSection`、`SETTINGS_SECTIONS`、`Section()` | `sections.ts:1-12`；`SettingsDialog.tsx:162-180` | 第 6 个分区 | 入口 |
| C10 | 代码 | `apps/ohbaby-web/src/ui/settings/ArchivedSection.tsx`（新） | 列表、恢复、删除确认 | 新文件 | D9 | 用户看到的主要变化 |
| C11 | 代码 | `apps/ohbaby-web/src/ui/sidebar/SessionMenu.tsx`、`SessionRow.tsx` | Archive 菜单项与悬停按钮 | `SessionMenu.tsx:202-211`；`SessionRow.tsx:193-202` | 非空闲时禁用 | D3 的界面提示 |
| D1 | 文档 | `docs/ohbaby-web/redesign-2026-10/00-goal-duty.md` | “不做”清单 | L69 | 去掉“归档列表的浏览界面” | 与本议题直接冲突 |
| D2 | 文档 | `docs/ohbaby-web/redesign-2026-10/README.md`、`01-use-cases-and-user-flows.md` | D12；设置分区 | `README.md:22`；`01:157,271` | 5 个分区改为 6 个，补用例 | 已确认决策的修改 |
| D3 | 文档 | `docs/ohbaby-web/redesign-2026-10/04-interaction-and-states.md` | 归档、Undo、已归档会话 | L52、L69、L171 | 改 Undo 说明，删 `Archived` 标记描述，补禁用归档 | 交互权威 |
| D4 | 文档 | `docs/ohbaby-web/redesign-2026-10/06-data-api-and-state.md`、`05-components.md` | 接口表；组件清单 | `06:11-16`；`05` 组件表 | 补 3 个接口和 `ArchivedSection` | 数据与组件权威 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-agent/src/services/session/index.ts`、`src/index.ts`：导出新函数。
- `packages/ohbaby-server/src/coordination/session-workspace-move.ts`：`GlobalSessionCatalog` 加方法。
- JSON-RPC 错误映射（`protocols/jsonrpc/rpc-route.ts` 附近）：`SessionRunBusyError` 的错误码。
- `packages/ohbaby-sdk/src/contract/global-sessions.ts`、`index.ts`：新类型和错误码常量。
- `apps/ohbaby-web/src/api/daemon/global-sessions.ts`、`dev/mock-runtime.ts`、`dev/mock-scenarios.ts`、`runtime/fake-daemon.test-support.ts`。
