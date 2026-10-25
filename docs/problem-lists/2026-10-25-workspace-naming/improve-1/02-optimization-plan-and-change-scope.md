# 2. 优化方案与改动面

> 本文是交给实施会话的契约。Stage 1、2 由用户实施，Stage 3、4 由 agent 实施。验收标准见 [04](04-test-and-acceptance.md)。路径相对仓库根目录。

## 2.1 方案总览

一句话：把会话上的 3 个目录字段从数据库到界面统一改成 workspace 和 working directory；project 只留给 Git 仓库身份；Web 侧栏的 No project 分组改成底部的 Recents。

改动按“由里到外”分 4 个 Stage。每个 Stage 结束时，全仓库类型检查和测试都要通过：

```
Stage 1  数据库列 + 核心会话领域        REST、JSON-RPC、SDK 契约不变（ohbaby-agent 的导出名会变）
   │
Stage 2  SDK、REST、JSON-RPC 契约       客户端同步改字段名（CLI 页脚、Web 接口层）
   │
Stage 3  Web 界面                        命名、文案、Recents、浏览器存储 key
   │
Stage 4  权威文档同步
```

先改里层、再改契约、最后改界面，每一步都只有一个变化原因。Stage 1 结束时 daemon 对外的接口不变，可以单独合并；但数据库已经升级，回滚要用备份（见 2.6）。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 列改名方式 | 新迁移 `026`，三条 `ALTER TABLE ... RENAME COLUMN` | 不搬数据，SQLite 自动更新引用；和已有迁移的写法一致 | 新建列、复制数据、删旧列 | 不可逆：旧版本读不了新库 |
| 升级保护 | `026` 设置 `requiresOfflineBackup: true`；初始化数据库时把 `daemon.pid` 里的 PID（排除自己）传给 `knownWriterPids` | 复用 `022` 的备份机制；补上 daemon PID 后，旧 daemon 还活着时拒绝升级 | 不设保护；或新做一套进程锁 | 升级时多一次 `VACUUM INTO` 备份；空闲的旧 TUI 仍然发现不了，靠发布说明 |
| 核心改名范围 | 只改 a 类（会话字段及其直接读写方），由类型检查划定 | b 类本来就指 Git 根或宿主目录，改了反而错 | 全局替换 `projectRoot` | 引擎层仍有 `projectRoot` 参数，登记为后续候选 |
| SDK 兼容 | `ohbaby-sdk` 和 `ohbaby-agent` 都直接改名，不留旧名字别名；发布说明写明不兼容变化 | 0.x 版本允许不兼容变更，没有已知外部使用者（00 P1，待确认） | 新旧字段并存一个版本 | 外部使用者升级时需要改代码 |
| 移动路由 | `POST /v1/sessions/:sessionId/project` → `.../workspace`，旧路由删除 | Web 和 daemon 同版本发布 | 保留旧路由转发 | 见下一行 |
| 未刷新的旧网页 | 不加版本检查，发布说明要求升级后刷新页面 | 新增版本协商机制超出本轮范围 | 用健康检查里的 `packageVersion` 提示刷新 | 旧页面读不到 `projectDirectory`，侧栏可能报错，刷新后恢复 |
| 请求头常量 | 改为 `REQUEST_DIRECTORY_*`，头的取值不变 | 避免和 `workspaceDirectory` 撞名，线上协议不变 | 保留原名 | 改动 SDK 一个导出名 |
| 默认目录 | 代码改名为 default directory，磁盘路径不变 | 去掉“无工作区会话跑在 default workspace 里”的绕口说法 | 连路径一起改 | 路径里仍有 `workspace` 字样，用注释说明 |
| 服务端 scope 命名 | 不改 | scope 指“目录对应的运行实例”，含义正确 | 全部改成 workspace | 无 |
| 会话导出格式 | 字段 `session.projectRoot` 不改，导出时从 `workingDirectory` 取值 | 已发布的文件格式，改它要升版本 | 升到 version 2 | 导出文件里的名字和内部名字不同 |
| Web 折叠状态 | key 升到 `ohbaby.web.sidebar.collapsed.v2`，旧值丢弃 | 外观偏好，不值得写转换代码 | 读旧值转换前缀 | 升级后分组全部展开一次 |
| Recents | 只放无工作区会话，按更新时间倒序，不能折叠，沿用现有分页 | 用户确认；全局目录已按 `updatedAt` 排序 | 放全部会话（会和工作区分组重复） | 名字可能让人以为是“全部最近会话” |

## 2.3 分阶段实施

### 改名对照表（各 Stage 共用）

核心与存储（Stage 1）：

| 旧名 | 新名 | 位置 |
|---|---|---|
| 列 `project_directory` / `project_root` / `pending_project_root` | `workspace_directory` / `working_directory` / `pending_working_directory` | 迁移 `026`、`schema.ts` |
| `Session.projectDirectory` / `projectRoot` / `pendingProjectRoot` | `workspaceDirectory` / `workingDirectory` / `pendingWorkingDirectory` | `services/session/types.ts`、`events.ts` |
| `SessionExecutionRootInput`（字段 `projectRoot`） | `SessionWorkingDirectoryInput`（字段 `workingDirectory`） | `types.ts` |
| `EnsureRootSessionInput.projectRoot` | `workingDirectory` | `types.ts` |
| `create(projectDirectory)`、`findReusableEmptyPrimary(projectDirectory)` 的参数 | `directory` | `types.ts`、`manager.ts`（只改参数名，它是待解析的输入目录） |
| `listByProjectRoot` | `listByWorkingDirectory` | manager 与 store |
| `recordExecutionRoot` | `recordWorkingDirectory` | manager 与 store |
| `listByProject(projectId)` | 不变 | 按 Git 身份查询 |
| `services/session/project-root.ts` | `working-directory.ts` | 文件改名 |
| `sessionTargetProjectRoot` / `withSessionExecutionRoot` / `isSessionInProjectRoot` | `sessionTargetWorkingDirectory` / `withSessionWorkingDirectory` / `isSessionInWorkingDirectory` | 同上 |
| `sameSessionProjectRoot` / `normalizeSessionProjectRoot` / `SessionProjectRootCompareOptions` / `isSessionProjectRootCaseInsensitivePlatform` | `sameSessionDirectory` / `normalizeSessionDirectory` / `SessionDirectoryCompareOptions` / `isSessionDirectoryCaseInsensitivePlatform` | 同上（它们比较的是任意目录） |
| `resolveSessionProjectBinding` | `resolveSessionWorkspaceBinding` | 同上 |
| `services/session/project-move.ts` 及 `SessionProjectMove*`、`planSessionProjectMove`、`commitSessionProjectMove` | `workspace-move.ts`、`SessionWorkspaceMove*`、`planSessionWorkspaceMove`、`commitSessionWorkspaceMove` | 文件与符号 |
| `listKnownSessionProjectRoots` / `ProjectRootRow` | `listKnownSessionWorkingDirectories` / `WorkingDirectoryRow` | `database-store.ts` |
| `SessionProjectBinding` / `writeSessionProjectBinding` | `SessionWorkspaceBinding` / `writeSessionWorkspaceBinding` | 同上 |
| `clearDefaultWorkspaceProjectBindings` | `clearDefaultDirectoryWorkspaceBindings` | 同上、`adapters/ui-persistent.ts` |
| `NOT_IN_HIDDEN_PROJECT` | `NOT_IN_HIDDEN_WORKSPACE` | `global-query.ts` |
| `requiredContext` 里的 `"session.projectRoot"` | `"session.workingDirectory"` | `bus/event-catalog.ts` |
| `paths/default-workspace.ts` 及 `DEFAULT_WORKSPACE_DIR_MODE`、`resolveDefaultWorkspaceDirectory`、`ensureDefaultWorkspaceDirectory`、`isDefaultWorkspaceDirectory`、`defaultWorkspaceBoundary` | `default-directory.ts`、`DEFAULT_DIRECTORY_MODE`、`resolveDefaultDirectory`、`ensureDefaultDirectory`、`isDefaultDirectory`、`defaultDirectoryBoundary` | `isSameCanonicalDirectory` 不变 |
| `defaultWorkspaceForms` | `defaultDirectoryForms` | `adapters/ui-persistent.ts` |
| `adoptSessionProjectMove` | `adoptSessionWorkspaceMove` | 实现在 `adapters/ui-persistent.ts:116,823`，接口在服务端 `runtime/daemon/server.ts:99` 的 `WorkspaceBackend`，两边在 Stage 1 一起改 |

契约（Stage 2）：

| 旧名 | 新名 |
|---|---|
| `UiDefaultWorkspace` | `UiDefaultDirectory` |
| `UiGlobalSession.projectDirectory` | `workspaceDirectory` |
| `UiSessionProjectUpdate { projectDirectory }` | `UiSessionWorkspaceUpdate { workspaceDirectory }` |
| `UiSession.projectRoot`、`UiSessionIndexEntry.projectRoot` | `workingDirectory` |
| `UiSettingsAboutResponse.defaultWorkspace`、`GET /v1/scopes` 响应里的 `defaultWorkspace` | `defaultDirectory` |
| `contract/workspace-directory-header.ts`、`WORKSPACE_DIRECTORY_HEADER`、`WORKSPACE_DIRECTORY_ENCODING_HEADER`、`WORKSPACE_DIRECTORY_ENCODING_PERCENT_UTF8`、`workspaceDirectoryHeaders` | `request-directory-header.ts`、`REQUEST_DIRECTORY_HEADER`、`REQUEST_DIRECTORY_ENCODING_HEADER`、`REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8`、`requestDirectoryHeaders`（头的取值不变） |
| `POST /v1/sessions/:sessionId/project`，请求体 `projectDirectory` | `POST /v1/sessions/:sessionId/workspace`，请求体 `workspaceDirectory` |
| 错误码 `DEFAULT_WORKSPACE_NOT_PROJECT`、`DefaultWorkspaceNotProjectError` | `DEFAULT_DIRECTORY_NOT_WORKSPACE`、`DefaultDirectoryNotWorkspaceError` |
| 服务端 `session-project-move.ts`、`moveSessionProject`、`SessionProjectMoveDeps`、`parseSessionProjectUpdate` | `session-workspace-move.ts`、`moveSessionWorkspace`、`SessionWorkspaceMoveDeps`、`parseSessionWorkspaceUpdate` |

### Stage 1：数据库列与核心会话领域（用户实施）

**目标**：数据库和核心会话代码只用新名字；daemon 对外的 REST、JSON-RPC 和 SDK 契约不变。`ohbaby-agent` 自己的导出名（`src/index.ts:165,178-189`）在这一步就会改变。

**做法**：

1. 在 `migrations.ts` 末尾追加迁移：

   ```ts
   {
     // project_root has always been the execution directory; project_directory
     // is the sidebar workspace. Names now say so. Older builds cannot open
     // the upgraded database, hence the offline backup.
     version: "026_session_workspace_naming",
     requiresOfflineBackup: true,
     sql: `
       ALTER TABLE session RENAME COLUMN project_directory TO workspace_directory;
       ALTER TABLE session RENAME COLUMN project_root TO working_directory;
       ALTER TABLE session RENAME COLUMN pending_project_root TO pending_working_directory;
     `,
   },
   ```

   已发布的迁移 `001`、`025` 的 SQL 一个字都不改，否则老用户的升级路径会变。
2. 补上升级保护：唯一的调用入口 `adapters/ui-persistent.ts:683` 调 `initDatabase` 时，读取 `<OHBABY_HOME>/server/daemon.pid`（路径的拼法见 `migration/ohbaby-home.ts:521`），PID 存在且不是当前进程时，作为 `knownWriterPids` 传入（`services/database/types.ts:34` 已有这个选项，`index.ts:199` 已会检查）。没有这个文件或读不出数字就不传。
3. 改 `Session` 类型字段和 `SessionRow`。**先改类型、再按编译错误逐个修**，不要对 `projectRoot` 做文本替换：编译器报错的地方就是 a 类读写方，没报错的 b 类局部变量保持原名。手写 SQL（`database-store.ts`、`global-query.ts`）和 `SELECT *` 的行映射不受类型检查保护，要逐条对照改；`schema.ts` 的列名映射同步改。
4. 按改名对照表改会话领域的文件名和符号，以及 `src/index.ts` 的再导出。
5. `adapters/ui-inprocess.ts` 只改读写**核心 `Session`** 字段的表达式（如 `coreSession.projectRoot` → `coreSession.workingDirectory`）。这个文件里很多 `session` 变量是 `UiSession`，它的 `projectRoot` 在 Stage 2 才改，这一步不动；宿主目录相关的 `resolveProjectRoot`、`baseProjectRoot` 等局部名也不动。
6. 引擎层参数（`AgentInstanceIdentity.projectRoot`、run-manager、lifecycle、context 的 `projectRoot`）不改。在调用处写成 `projectRoot: session.workingDirectory`，读起来就是“本轮的项目配置目录取会话的运行目录”。
7. 适配层把新字段映射回旧契约，保证 Stage 1 对外不变：`adapters/ui-state/persistent-store.ts`、`memory-store.ts`、`ui-inprocess/session-controller.ts` 给 `UiSession.projectRoot` 赋值时读 `session.workingDirectory`；服务端 `protocols/global-sessions.ts:22-26` 给 `projectDirectory` 赋值时读 `session.workspaceDirectory`。
8. 会话导出 `services/session-export/collect.ts:233` 写成 `projectRoot: session.workingDirectory`，导出格式不变。
9. 事件目录：`bus/event-catalog.ts:355,366` 的 `requiredContext` 和 `docs/bus/event-catalog.md:32-33` 一起改，否则 `bus/event-catalog.contract.test.ts` 会失败。
10. 原始 SQL：测试辅助 `core/context/testing/context-compaction-crash-child.ts:79`，以及直接往 `project_root` 写数据的约 28 个测试文件（用下方完成定义里的 `rg` 列出，含 Web 的 `api/daemon/new-session-regression.integration.test.ts`），全部改用新列名。
11. 服务端只改编译需要的引用，不改路由、请求体和错误码：`runtime/daemon/main.ts:7-13,548,554-556`、`runtime/daemon/server.ts:19-21,99,374,709`（默认目录函数、`SessionWorkspaceMovePlan`、`WorkspaceBackend.adoptSessionWorkspaceMove`）、`coordination/session-project-move.ts` 调用的核心函数、`protocols/web/routes/global-settings.ts:32`。

**完成定义**：

- `pnpm typecheck` 通过。
- `pnpm test:unit`、`pnpm test:contract`、`pnpm test:integration` 通过。
- 04 T1 至 T6 通过，其中 T1、T2 是新增的迁移测试。
- `rg -n "project_root|project_directory|pending_project_root" packages apps --glob '!**/dist/**'` 只在迁移 `001`、`025`（含其注释）和 T1 准备旧数据的代码里出现。

### Stage 2：SDK、REST、JSON-RPC 契约（用户实施）

**目标**：对外契约换成新名字，仓库里的所有客户端同步改，旧名字不留。

**做法**：

1. 按契约改名对照表改 SDK 的类型、文件名和 `index.ts` 导出。请求头常量的使用方一起改：服务端 `protocols/jsonrpc/client.ts:12,976`、`protocols/web/routes/settings.ts:2`、`runtime/daemon/server.ts`，Web 的 `api/daemon/events.ts:2`、`api/daemon/http.ts:49`。
2. 服务端改路由路径、请求体字段、错误码、错误消息和“关于”接口字段。错误码 `DEFAULT_DIRECTORY_NOT_WORKSPACE` 同时用于移动接口和 `POST /v1/scopes/open`（`server.ts:499-506`）。错误消息里的 project 一并改掉，例如 `"workspaceDirectory must be a directory path or null"`、`"The default directory cannot be opened as a workspace"`、`main.ts:483` 的 `"global project rail"` 改为 `"workspace list"`。
3. `app/openapi.ts` 更新“关于”接口的 `defaultDirectory` 字段，以及请求头描述里的 “Workspace directory” 字样。
4. 去掉 Stage 1 第 7 步的回映射：适配层直接输出 `workingDirectory`、`workspaceDirectory`。
5. CLI 跟着 `UiSession.workingDirectory` 改读取方：`tui/app.tsx:1234`、`tui/components/prompt/index.tsx`、`footer.ts`。`/status` 面板的 “Project” 标签不在本轮。
6. Web 只改接口层，让它能编译、测试能通过，不动界面：`api/daemon/global-sessions.ts`（路由和请求体）、`api/daemon/wire.ts`、`runtime/fake-daemon.test-support.ts`（第 218 行的路由正则改为 `/workspace$/`）、`ui/settings/AboutSection.tsx` 读 `defaultDirectory`，以及因字段改名报错的地方（只改字段读写，不改组件名和文案）。
7. 在下一版发布说明里写明：`ohbaby-sdk` 和 `ohbaby-agent` 的不兼容变化与改名对照表；数据库升级后不能降级，回退要用升级前的备份（文件名沿用 `.before-retained-<uuid>.backup`）；升级前退出所有 ohbaby 进程；升级后刷新已打开的 Web 页面。

**完成定义**：

- `pnpm typecheck` 和全部测试通过。
- `rg -n "projectDirectory|DEFAULT_WORKSPACE_NOT_PROJECT|WORKSPACE_DIRECTORY_HEADER|/project\b" packages/ohbaby-sdk/src packages/ohbaby-server/src --glob '!**/dist/**'` 没有本概念的命中（`migrateOhbabyData` 的 `projectDirectory` 选项属于 b 类，保留）。
- 04 T7 至 T9 通过。

### Stage 3：Web 界面（agent 实施）

**目标**：用户看不到 project 字样（Git 相关和 Skills 来源除外），无工作区会话出现在 Recents。

**做法**：

1. 命名：`SidebarProject` → `SidebarWorkspace`，`SidebarProjectGroup` → `SidebarWorkspaceGroup`，`SidebarGroups.projects` / `noProject` → `workspaces` / `recents`，组 key `"no-project"` → `"recents"`、`` `project:${dir}` `` → `` `workspace:${dir}` ``，`projectGroupKey` → `workspaceGroupKey`；全局目录的 `projects`、`projectsStatus`、`setProjects`、`failProjects`、`removeProject` 换成 workspace；`refreshProjects`、`openDraft`、`moveSession`、`projectOf`、`draft.setProject`、`App.tsx` 的 `legacyDraftProject` 等同步。
2. 组件与文件：`ProjectGroup` → `WorkspaceGroup`，`ProjectMenu` → `WorkspaceMenu`，`ProjectPicker` → `WorkspacePicker`，`collapsed-projects.ts` → `collapsed-groups.ts`；CSS 类 `ohb-project-*` → `ohb-workspace-*`。
3. 文案：

   | 旧 | 新 |
   |---|---|
   | `Projects` | `Workspaces` |
   | `Projects could not be loaded. Retry` | `Workspaces could not be loaded. Retry` |
   | `No project`（侧栏分组） | `Recents` |
   | `No project`（草稿选择器） | `No workspace` |
   | `New chat in ${label}` | 不变 |
   | `Project actions for ${label}` | `Workspace actions for ${label}` |
   | `Hide project` | `Hide workspace` |
   | `Move to project`、`Move to project…` | `Move to workspace`、`Move to workspace…` |
   | `Remove from project` | `Remove from workspace` |
   | `Choose a project`，标题 `Project`，`Project: ${label}` | `Choose a workspace`，`Workspace`，`Workspace: ${label}` |
   | `The default workspace is not available. Choose a project to start.` | `The default directory is not available. Choose a workspace to start.` |
   | `Open project`（目录选择对话框） | `Open workspace` |

4. Recents：在所有工作区分组之后渲染，标题是普通文字、没有折叠按钮；内容是 `workspaceDirectory === null` 且未置顶的会话，顺序沿用全局目录的 `updatedAt` 倒序；分页沿用现有的 6 条起步、Show more 每次加 20 条。显示条件也沿用现状（`sidebar-groups.ts:138-141`）：本地已加载的行为空**并且**服务端没有更多页时才隐藏，否则用户就没有入口去加载更早的无工作区会话。
5. 浏览器存储：折叠状态 key 改为 `ohbaby.web.sidebar.collapsed.v2`，启动时 `removeItem` 掉 v1、不转换旧值；草稿 key 改为 `ohbaby:draft-workspace:new`。
6. mock 场景改名（`agentProject` → `agentWorkspace` 等，场景说明改成 workspace），相关测试同步。

**完成定义**：

- Web 类型检查和测试通过。
- `rg -n "[Pp]roject" apps/ohbaby-web/src --glob '!**/*.test.*'` 剩下的命中都属于 01 §1.5 列出的“不属于本概念”一类。
- 04 T10 至 T13 通过，包括浏览器走查。

### Stage 4：权威文档同步（agent 实施）

**目标**：前端设计文档与实现一致。

**做法**：按 2.9 的 D 行更新 `docs/ohbaby-web/redesign-2026-10/` 下的文档：术语表、侧栏顺序（Pinned → Workspaces → Recents）、接口表、ViewModel 字段名、mock 说明；同时更新 `docs/ohbaby-web/ui/components.md:28` 和 `docs/services/session/dfd-interface.md:39,134`。`docs/bus/event-catalog.md` 已在 Stage 1 改过。历史验收文档和上一议题的文档不改。

**完成定义**：04 T14 通过。

## 2.4 按包和目录的改动面

| 包 / 目录 | 新增 | 修改 | 删除（改名） | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-agent/src/services/database` | 迁移 `026` | `schema.ts` | 无 | Stage 1 |
| `packages/ohbaby-agent/src/services/session` | 无 | `types.ts`、`manager.ts`、`store.ts`、`database-store.ts`、`global-query.ts`、`events.ts`、`index.ts` | `project-root.ts` → `working-directory.ts`，`project-move.ts` → `workspace-move.ts` | Stage 1 |
| `packages/ohbaby-agent/src/paths` | 无 | `index.ts` | `default-workspace.ts` → `default-directory.ts` | Stage 1 |
| `packages/ohbaby-agent/src/adapters` | 无 | `ui-inprocess.ts`、`ui-persistent.ts`（含 `knownWriterPids`）、`ui-state/*`、`ui-inprocess/session-controller.ts`、`ui-runtime/permission-source.ts` | 无 | Stage 1 改字段读写，Stage 2 去掉回映射 |
| `packages/ohbaby-agent/src/agents`、`bus`、`services/session-export`、`project`、`core/system-prompt/layers`、`index.ts` | 无 | `service.ts`、`subagent-host.ts`、`event-catalog.ts`、`collect.ts`、`project-manager.ts`、`environment.ts`、`src/index.ts` | 无 | Stage 1 |
| `packages/ohbaby-agent/src`、`apps/ohbaby-web/src` 的测试 | 迁移测试（T1、T2） | 约 28 个写原始 SQL 的测试文件 | 无 | Stage 1 |
| `packages/ohbaby-sdk/src/contract` | 无 | `global-sessions.ts`、`snapshot.ts`、`permission.ts`、`settings.ts`、`client.ts`（注释）、`../index.ts` | `workspace-directory-header.ts` → `request-directory-header.ts` | Stage 2 |
| `packages/ohbaby-server/src` | 无 | `protocols/global-sessions.ts`、`protocols/jsonrpc/client.ts`、`protocols/web/routes/{global-settings,settings}.ts`、`runtime/daemon/server.ts`、`runtime/daemon/main.ts`、`app/openapi.ts` | `coordination/session-project-move.ts` → `session-workspace-move.ts` | Stage 1 改引用，Stage 2 改契约 |
| `packages/ohbaby-cli/src/tui` | 无 | `app.tsx`、`components/prompt/index.tsx`、`footer.ts` | 无 | Stage 2 |
| `apps/ohbaby-web/src` | 无 | 接口层，含 `api/daemon/{global-sessions,wire,events,http}.ts`（Stage 2）；store、runtime、ui、dev（Stage 3） | 组件文件改名（Stage 3） | Stage 2、3 |
| `docs/bus` | 无 | `event-catalog.md` | 无 | Stage 1（契约测试比对） |
| `docs/ohbaby-web`、`docs/services/session` | 无 | `redesign-2026-10/` 下 6 篇、`ui/components.md`、`dfd-interface.md` | 无 | Stage 4 |

## 2.5 API、协议、迁移与兼容

- **数据库**：只能升级，不能降级。升级前自动备份到 `<数据库路径>.before-retained-<uuid>.backup`。
- **REST**：移动路由改路径和请求体；`GET /v1/scopes` 和 `GET /v1/settings/about` 的 `defaultWorkspace` 改为 `defaultDirectory`；其余路由不变。
- **多进程共用数据库**：这是版本不一致最容易出问题的地方。TUI 默认在进程内运行，和后台 daemon 共用同一个数据库；任何一个新版本进程先启动都会执行迁移，此后旧版本进程再写会话就会报 “no such column”。升级前要退出所有 ohbaby 进程；Stage 1 第 2 步能拦住还活着的旧 daemon，拦不住空闲的旧 TUI。
- **JSON-RPC / 快照**：`UiSession.projectRoot` 改为 `workingDirectory`。远程连接 daemon 的 TUI 必须和 daemon 同版本。
- **请求头**：取值 `x-ohbaby-directory` 和 `x-ohbaby-directory-encoding` 不变，只改 SDK 常量名。
- **会话导出文件**：格式和版本都不变。
- **公开包**：`ohbaby-sdk` 和 `ohbaby-agent` 都是 0.x 内的不兼容变更，发布说明列出改名对照表。

## 2.6 风险与回滚

| 风险 | 表现 | 预防 | 回滚 |
|---|---|---|---|
| 把 b 类误改成 a 类 | 配置、`.env`、`OHBABY.md` 从错误目录加载 | 先改类型、按编译错误修，不做文本替换；评审时逐个看 `ui-inprocess.ts` 的改动 | 代码回退 |
| 漏掉 a 类 | 编译失败 | 类型检查兜底 | 无需回滚 |
| 旧 daemon 还在运行 | 升级被拒绝，报 `DatabaseUpgradeBlockedError` | `requiresOfflineBackup` 加 `daemon.pid` | 停掉旧 daemon 后重启 |
| 空闲的旧 TUI 还开着 | 迁移成功，旧 TUI 下次写会话时报 “no such column” | 发布说明要求升级前退出所有 ohbaby 进程 | 关掉旧 TUI，用新版本重开 |
| 新版本上线后要退回旧版本 | 旧版本找不到 `project_root` 列 | 升级前自动备份 | 停服务，用备份文件替换数据库，装回旧版本；备份之后新建的会话会丢失 |
| 未刷新的旧网页 | 移动会话返回 404；侧栏读不到 `projectDirectory`，可能报错 | 发布说明 | 刷新页面 |
| 外部使用 `ohbaby-sdk` 或 `ohbaby-agent` | 编译失败 | 发布说明 | 锁定旧版本 |
| SQL 里手写的旧列名 | 运行时报 “no such column”，或 `SELECT *` 读出 `undefined` | Stage 1 完成定义里的 `rg` 检查；T3 断言真实行读出 3 个字段；集成测试覆盖全局列表和移动 | 代码回退 |

## 2.7 与 00 的边界对齐

| 00 中的结论 | 本文落点 |
|---|---|
| 术语表 | 2.3 改名对照表 |
| 迁移 `026`、不支持降级 | Stage 1 第 1、2 步，2.5，2.6 |
| 只改会话领域的 `projectRoot` | Stage 1 第 3 至 6 步 |
| SDK 直接改名（P1） | Stage 2、2.5 |
| 默认目录只改代码名 | 改名对照表、2.2 |
| Web 文案与 Recents | Stage 3 |
| 4 个 Stage 与分工 | 2.3 |
| P2 至 P7 | 2.2、Stage 1、Stage 2、Stage 3 |
| 行为不变 | 2.1；04 回归清单 |

## 2.8 不在本轮

| 事项 | 原因 | 去向 |
|---|---|---|
| 归档会话管理（Settings 页面、恢复、永久删除） | 独立议题 | `../../2026-10-25-archived-sessions/`，本议题完成后规划 |
| 引擎层 `projectRoot` 参数（a′ 类） | 含义是“本轮的项目配置目录”，需要单独判断该叫什么 | 后续候选 |
| 会话导出格式 `session.projectRoot` | 已发布的文件格式，改它要升版本 | 后续候选 |
| TUI `/status` 的 “Project” 标签 | 显示的是宿主实例目录，不是本概念 | 后续候选 |
| 服务端 scope 命名 | 含义正确 | 不改 |
| 默认目录的磁盘路径 | 避免搬用户文件 | 不改 |

## 2.9 关键改动清单

> 行号是 `00911105` 的快照，定位以符号为准。本表不是进度表，实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号 / 小节 | 行号快照 | 要改什么 | 为何承重 |
|---|---|---|---|---|---|---|
| C1 | 代码 | `packages/ohbaby-agent/src/services/database/migrations.ts` | 末尾新增 `026_session_workspace_naming` | L634-645 之后 | 三条 `RENAME COLUMN`，`requiresOfflineBackup: true` | 唯一不可逆的一步 |
| C2 | 代码 | `packages/ohbaby-agent/src/adapters/ui-persistent.ts` | `initDatabase` 调用 | L683 | 传入 `daemon.pid` 里的 PID 作为 `knownWriterPids` | 没有它，升级保护发现不了空闲的旧 daemon |
| C3 | 代码 | `packages/ohbaby-agent/src/services/session/types.ts` | `Session`、`SessionExecutionRootInput`、`EnsureRootSessionInput`、`SessionManager`、`SessionStore` | L14-20、L64-68、L82、L89-99、L118 | 字段与方法改名 | 改完后编译器列出全部 a 类读写方 |
| C4 | 代码 | `packages/ohbaby-agent/src/services/session/database-store.ts` | `SessionRow`、`listKnownSessionProjectRoots`、`writeSessionProjectBinding`、`clearDefaultWorkspaceProjectBindings`、`rowToSession`、`insertRow` / `writeRow` / `upsertRow` | L24-29、L47-138、L190-325 | 手写 SQL 里的列名和行映射（`schema.ts:12-14` 的映射同步改，但它不被 SQL 读取） | 读取走 `SELECT *` 加类型断言，漏改时读出 `undefined` 而不报编译错误 |
| C5 | 代码 | `packages/ohbaby-agent/src/services/session/global-query.ts` | `NOT_IN_HIDDEN_PROJECT` | L111 | 列名和常量名 | 手写 SQL，全局列表靠它过滤隐藏工作区 |
| C6 | 代码 | `packages/ohbaby-agent/src/services/session/project-root.ts`、`project-move.ts` | 全部导出 | 全文件 | 文件与符号改名 | 移动和目录切换的核心逻辑 |
| C7 | 代码 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 读写核心 `Session.projectRoot` 的表达式 | 例如 L2431、L3170-3235、L3477-3648 | Stage 1 只改核心 `Session` 字段读写；`UiSession.projectRoot`（如 L2775-2776、L3479）留到 Stage 2；宿主目录变量不动 | a、b 两类和两种会话类型混在同一个文件 |
| C8 | 代码 | `packages/ohbaby-agent/src/paths/default-workspace.ts` | 全部导出 | 全文件 | 文件与符号改名，路径不变 | 默认目录的唯一来源 |
| C9 | 代码 | `packages/ohbaby-sdk/src/contract/global-sessions.ts` | `UiDefaultWorkspace`、`UiGlobalSession`、`UiSessionProjectUpdate` | L6-8、L18-23、L45-48 | 契约改名 | 公开包的对外类型 |
| C10 | 代码 | `packages/ohbaby-sdk/src/contract/snapshot.ts`、`permission.ts`、`settings.ts`、`workspace-directory-header.ts` | `UiSession.projectRoot`、`UiSessionIndexEntry.projectRoot`、`defaultWorkspace`、请求头常量 | L104；L33；L143；L1-15 | 契约改名 | JSON-RPC 快照与请求头 |
| C11 | 代码 | `packages/ohbaby-server/src/runtime/daemon/server.ts` | 路由表、`moveSessionProject`、`/v1/scopes` 响应 | L308-309、L371-439、L503-504、L689-722 | 路由路径、`defaultDirectory`、错误消息 | 对外 REST 契约 |
| C12 | 代码 | `packages/ohbaby-server/src/protocols/global-sessions.ts` | `toUiGlobalSession`、`parseSessionProjectUpdate`、`globalSessionErrorStatus` | L22-26、L69-83、L96 | 字段映射、请求体解析、错误码 | 核心字段到契约字段的唯一映射点 |
| C13 | 代码 | `packages/ohbaby-server/src/coordination/session-project-move.ts` | `DefaultWorkspaceNotProjectError`、`moveSessionProject`、`SessionProjectMoveDeps` | L21-89 | 文件、符号、错误码改名 | 移动流程的服务端编排 |
| C14 | 代码 | `apps/ohbaby-web/src/store/sidebar-groups.ts` | `SidebarGroupKey`、`SidebarGroups`、`selectSidebarGroups` | L16-181 | 改名，`noProject` 变为 `recents` | 侧栏分组的唯一计算点 |
| C15 | 代码 | `apps/ohbaby-web/src/ui/sidebar/Sidebar.tsx` | 分组渲染与 No project 段 | L307-357 | 文案，Recents 改为不可折叠 | 用户看到的主要变化 |
| C16 | 代码 | `apps/ohbaby-web/src/api/daemon/global-sessions.ts` | `moveSession` | L49-58 | 新路由与请求体 | Web 与 daemon 的契约边界 |
| D0 | 文档 | `docs/bus/event-catalog.md` | `session.created`、`session.updated` 行 | L32-33 | `session.projectRoot` → `session.workingDirectory`（Stage 1） | `event-catalog.contract.test.ts` 比对，不改测试会失败 |
| D1 | 文档 | `docs/ohbaby-web/redesign-2026-10/01-use-cases-and-user-flows.md` | 术语表、流程、UC-PROJECT-01 至 03 | L15-16、L59、L72-150、L243-263 | 术语与用例改为 workspace | 前端用例权威 |
| D2 | 文档 | `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` | §4.2、§4.4、术语表 | L134-147、L187-246、L374 | 文案、侧栏细节、Recents | 界面权威 |
| D3 | 文档 | `docs/ohbaby-web/redesign-2026-10/04-interaction-and-states.md` | §2.1、§2.3、§2.5 | L31-36、L56-67、L86-92 | 侧栏顺序与字段名 | 交互权威 |
| D4 | 文档 | `docs/ohbaby-web/redesign-2026-10/06-data-api-and-state.md` | API 表、§2.1、§3.5、§5 | L11-16、L66-96、L196-201、L243-252 | 路由、ViewModel、草稿、mock | 数据契约权威 |
| D5 | 文档 | `docs/ohbaby-web/ui/components.md` | 侧栏分组约定 | L28 | “Pinned、Projects、No project” 改为 Pinned、Workspaces、Recents | Web 组件约定 |
| D6 | 文档 | `docs/services/session/dfd-interface.md` | 会话接口与字段 | L39、L134 | 字段名改为新名字 | 会话服务接口说明 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-agent/src/services/session/{manager,store,events,index}.ts`、`bus/event-catalog.ts`、`services/session-export/collect.ts`、`agents/{service,subagent-host}.ts`、`adapters/ui-persistent.ts`、`adapters/ui-state/*`、`adapters/ui-inprocess/session-controller.ts`、`adapters/ui-runtime/permission-source.ts`、`project/project-manager.ts`、`core/system-prompt/layers/environment.ts`：跟随 C3、C6、C8 改引用。
- `packages/ohbaby-agent/src/index.ts`：公开导出跟随 C3、C6、C8。
- `packages/ohbaby-server/src/runtime/daemon/main.ts`、`protocols/web/routes/{global-settings,settings}.ts`、`protocols/jsonrpc/client.ts`、`app/openapi.ts`：跟随 C8 至 C13。
- `packages/ohbaby-cli/src/tui/{app.tsx,components/prompt/index.tsx,footer.ts}`：跟随 C10。
- `apps/ohbaby-web/src/api/daemon/{events,http}.ts`：跟随 C10 的请求头常量。
- `apps/ohbaby-web/src` 的 store、runtime、ui、dev 及对应测试：跟随 C14 至 C16，文案见 Stage 3 表格。
- `docs/ohbaby-web/redesign-2026-10/02`、`05`、`08`：路由、组件名和验收条目里的 project 字样。
- 测试：核心约 70 个、服务端约 7 个、CLI 约 5 个、Web 14 个文件跟随改名；其中约 28 个直接写原始 SQL 的文件不受类型检查保护，要用 Stage 1 完成定义里的 `rg` 逐个找出。
