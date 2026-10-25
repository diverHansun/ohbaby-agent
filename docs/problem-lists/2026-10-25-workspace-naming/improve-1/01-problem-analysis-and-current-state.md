# 1. 现状与问题分析

> 时间口径：分支 `codex/redesign`，提交 `00911105`，2026-10-25。下文路径相对仓库根目录，行号是这一版的快照。

## 1.1 问题陈述

1. **同一个东西有三个名字。** 用户选的文件夹在 Web 和 SDK 里叫 project（`projectDirectory`），在服务端叫 workspace scope（`resolveWorkspaceScope`、`workspace_registry`），在数据库里叫 `project_directory`。读代码的人得自己记住这三个名字指的是同一个东西。
2. **project 一词被两个概念共用。** 核心 `project` 模块里的 project 是 Git 仓库身份（由 root commit 生成 `projectId`，非 Git 目录记为 `global`）；侧栏里的 project 是任意一个文件夹。两者经常同时出现在同一段代码里。
3. **`project_root` 名不副实。** 会话上的 `project_root` 存的是“这一轮在哪个目录运行”，`pending_project_root` 存的是“下一轮要切到哪个目录”。名字暗示它是 Git 项目根，实际不是。SDK 早就在边界上把它翻译成 `workingDirectory`，说明名字已经误导过人。
4. **“没有项目”的叫法绕口。** 无项目会话实际在 default workspace 目录里运行，于是出现了“没有 project 的会话跑在 default workspace 里”这种说法。
5. **侧栏把无项目会话当成一个分组。** `No project` 和项目分组并列、可折叠，但它不对应任何文件夹，用户也无法对它做“新建会话”“隐藏”等分组操作。

## 1.2 已确认的分界

术语见 [00 §2](00-discussion.md)。本轮只改名字，以及 Web 侧栏无工作区会话的展示方式；会话归属、移动、目录切换、全局列表和搜索的行为沿用 [上一议题 00 §2](../../2026-10-20-workspaceless-sessions-and-settings/improve-1/00-discussion.md)。

```
 用户选的文件夹 ──── workspace ──── session.workspace_directory（可空）
                                      │
 会话这一轮在哪跑 ── working directory ── session.working_directory
 下一轮切到哪 ───── pending working directory ── session.pending_working_directory
 Git 仓库身份 ───── project ──────── session.project_id（不变）
 无工作区新会话 ─── default directory ── <OHBABY_HOME>/workspace/default（路径不变）
```

## 1.3 ohbaby-agent（存储与核心会话）

### 数据模型

`packages/ohbaby-agent/src/services/database/schema.ts:12-14` 把 TS 名映射到列名：

| TS 名 | 列名 | 实际含义 | 来源 |
|---|---|---|---|
| `projectId` | `project_id` | Git 仓库身份 | 迁移 `001` |
| `projectRoot` | `project_root` | 当前或最近一轮的运行目录 | 迁移 `001`，`TEXT NOT NULL` |
| `projectDirectory` | `project_directory` | 侧栏分组，可空 | 迁移 `025` |
| `pendingProjectRoot` | `pending_project_root` | 下一轮的运行目录，可空 | 迁移 `025` |

`services/session/types.ts:14-20` 的注释已经写明了真实含义（“Execution directory used by the current or most recent turn”“Sidebar project”），只是字段名没跟上。

这 3 个列上没有索引或视图（唯一相关的索引 `idx_session_project_updated` 建在 `project_id` 上）。`session.data` 这个 JSON 列只存 `reasoning`、`childrenIds`、`isSubagent`（`database-store.ts:41-45`），改列名不会漏掉 JSON 里的数据。

需要注意的是，会话 SQL 全部是手写的，`schema.session.columns` 的映射并没有被 SQL 读取。读取走的是 `SELECT *` 加 `prepare<SessionRow>` 类型断言（`database-store.ts` 多处，`global-query.ts` 的 `SearchRow extends SessionRow`）。列名改了而 `SessionRow` 或 `rowToSession` 漏改时，读出来的字段是 `undefined`，编译器不会报错。

### 架构与接口

会话领域内直接读写这些字段的地方：

- `services/session/types.ts`：`Session`、`SessionExecutionRootInput`、`EnsureRootSessionInput`，以及 `SessionManager` / `SessionStore` 上的 `create(projectDirectory)`、`findReusableEmptyPrimary`、`listByProjectRoot`、`recordExecutionRoot`。
- `services/session/database-store.ts`：`SessionRow`（24-29）、`listKnownSessionProjectRoots`（47-75，对 `project_root` 和 `pending_project_root` 做 UNION）、`SessionProjectBinding` 与 `writeSessionProjectBinding`（78-115）、`clearDefaultWorkspaceProjectBindings`（126-138）、`rowToSession`、`insertRow` / `writeRow` / `upsertRow` 的列清单。
- `services/session/project-root.ts`：`sessionTargetProjectRoot`、`resolveSessionProjectBinding`、`withSessionExecutionRoot`、`isSessionInProjectRoot`、`sameSessionProjectRoot`、`normalizeSessionProjectRoot`，内部类型 `SessionRootFields`。
- `services/session/project-move.ts:17-91`：`SessionProjectMoveError`、`SessionProjectMovePlan`、`planSessionProjectMove`、`commitSessionProjectMove`。
- `services/session/global-query.ts:111`：`NOT_IN_HIDDEN_PROJECT` 直接在 SQL 里写 `project_directory`。
- `services/session/events.ts:13-15` 的 zod `SessionSchema`；`bus/event-catalog.ts:355,366` 的 `requiredContext: "session.projectRoot"` 字符串。
- `services/session/manager.ts:81-90` 的 `createSessionRecord`：默认目录的新会话不写 `projectDirectory`，子代理继承父会话的值。

### `projectRoot` 一词在核心包里的分布

核心包非测试代码里 `projectRoot` 出现约 215 次，含义分三类：

| 类别 | 含义 | 典型位置 | 本轮处理 |
|---|---|---|---|
| a | 会话字段本身，或直接读写它的地方 | `services/session/*`、`adapters/ui-state/persistent-store.ts:300,557`、`adapters/ui-inprocess/session-controller.ts`、`agents/service.ts:54,88`、`agents/subagent-host.ts:998,1561`、`adapters/ui-runtime/permission-source.ts:43,75,84` | 改名 |
| a′ | 引擎层参数，值来自会话字段，用途是“本轮按哪个目录找项目配置” | `core/agents/types.ts`、`core/agents/runner.ts`、`runtime/run-manager/*`、`core/lifecycle/*`、`core/context/*` | 不改，见 00 P4 |
| b | 别的含义：宿主实例目录、Git 根、配置目录 | `adapters/ui-inprocess.ts` 的 `resolveProjectRoot` / `baseProjectRoot`、`config/llm/*`、`utils/project-env.ts`、`commands/builtin.ts`、`project/*` | 不改 |

`adapters/ui-inprocess.ts`（4858 行）三类都有，常常出现在同一个表达式里，例如用宿主目录（b）和 `session.projectRoot`（a）比较。这是本轮最容易改错的文件。

### 默认目录

`packages/ohbaby-agent/src/paths/default-workspace.ts` 导出 `DEFAULT_WORKSPACE_DIR_MODE`、`resolveDefaultWorkspaceDirectory`、`ensureDefaultWorkspaceDirectory`、`isDefaultWorkspaceDirectory`、`defaultWorkspaceBoundary`、`isSameCanonicalDirectory`。调用方有 `adapters/ui-persistent.ts:26,123`、`services/session/manager.ts:83`、`project/project-manager.ts:42,48`、`core/system-prompt/layers/environment.ts:38,49`，以及服务端。

### 迁移机制

- 驱动是 `node:sqlite`（`services/database/connection.ts:5,59`），Node 24 自带的 SQLite 版本高于 3.25，支持 `ALTER TABLE ... RENAME COLUMN`。
- 迁移运行器在 `services/database/index.ts:128-247`：按版本跳过已执行的迁移，每个迁移在一个事务里执行并写入 `migration` 表。
- 迁移带 `requiresOfflineBackup` 时（目前只有 `022`），升级前先检查别的进程，再用 `VACUUM INTO` 备份（`index.ts:187-232`）。检查只覆盖两类进程：`run_ledger`、`subagent_instance`、`prompt_submission` 里有运行中记录的 `owner_pid`，以及调用方传入的 `knownWriterPids`。目前没有任何调用方传 `knownWriterPids`，所以空闲的旧 daemon 或旧 TUI 都不会被发现。
- 多进程共用同一个数据库是常态：TUI 默认在进程内运行，同时可能还有一个后台 `ohbaby serve` daemon（`packages/ohbaby-cli/src/serve-awareness.ts:115`），daemon 的 PID 记录在 `<OHBABY_HOME>/server/daemon.pid`。
- 测试模式：`retained-migration.integration.test.ts` 先跑旧迁移、写入旧数据，再执行目标迁移；`services/session/project-binding.integration.test.ts:107-113` 用同样方法测 `025`；`database.integration.test.ts:207` 列出全部迁移版本。

### 测试现状

会话字段相关的测试覆盖较全：存储（`database-store.integration`、`store.unit`）、移动（`project-binding.integration`、`adapters/session-project-move.integration`）、全局列表（`global-query.integration`）、运行时（`runtime/*` 7 个文件）。核心包里提到旧名字的测试文件约 70 个，服务端约 7 个，CLI 约 5 个。

两个风险：

- 改名是机械操作，测试大多只会跟着改名，未必能发现“把 b 类误改成 a 类”这种错误。
- 有 28 个测试文件在完整迁移后直接用原始 SQL 往 `project_root` 插数据，例如 `snapshot/snapshot.integration.test.ts:31`、`runtime/run-ledger/database.integration.test.ts:59`，Web 的 `api/daemon/new-session-regression.integration.test.ts:342` 也是。它们不受类型检查保护，改列名后会在运行时失败。

`bus/event-catalog.contract.test.ts:72` 会把代码里的事件目录和 `docs/bus/event-catalog.md` 逐行比较，文档第 32-33 行写着 `session.projectRoot`，所以改 `requiredContext` 时必须同时改这份文档。

迁移本身需要新增专门的升级测试。

## 1.4 ohbaby-server 与 ohbaby-sdk（契约）

### SDK

| 位置 | 现状 |
|---|---|
| `packages/ohbaby-sdk/src/contract/global-sessions.ts:6-8` | `UiDefaultWorkspace { directory }` |
| 同文件 `:18-23` | `UiGlobalSession.projectDirectory`；`workingDirectory`、`pendingWorkingDirectory` 已经是目标名字 |
| 同文件 `:45-48` | `UiSessionProjectUpdate { projectDirectory }`（移动请求体） |
| `contract/snapshot.ts:104` | `UiSession.projectRoot`（会话运行目录，a 类） |
| `contract/permission.ts:33` | `UiSessionIndexEntry.projectRoot`（同上） |
| `contract/settings.ts:143` | `UiSettingsAboutResponse.defaultWorkspace` |
| `contract/workspace-directory-header.ts:1-15` | `WORKSPACE_DIRECTORY_HEADER = "x-ohbaby-directory"`、`workspaceDirectoryHeaders()` 等 |
| `contract/settings.ts:10,22,28,39` | `"project"`、`"project-native"`：配置来源层级，**不是本概念** |

`ohbaby-sdk` 是 npm 公开包（`package.json` 设置了 `publishConfig.access: "public"`，当前 0.1.16），根 `README.md:189-194` 把它列为对外发布的四个包之一。仓库内的使用方是 ohbaby-agent、ohbaby-server、ohbaby-cli 和 `apps/ohbaby-web`；没有文档提到外部使用者。

`ohbaby-agent` 同样是公开包，`src/index.ts:165,178-189` 导出了 `planSessionProjectMove`、`listKnownSessionProjectRoots`、`sessionTargetProjectRoot`、默认目录相关函数和 `CoreSession` 类型，所以 Stage 1 的核心改名也会改变它的公开导出。

请求头常量叫 `WORKSPACE_DIRECTORY_*`，但它带的是请求要路由到的目录。使用这些常量的地方有 `server/protocols/jsonrpc/client.ts:12,976`、`server/protocols/web/routes/settings.ts:2`、`server/runtime/daemon/server.ts`、Web 的 `api/daemon/events.ts:2` 和 `api/daemon/http.ts:49`。无工作区会话的请求会带默认目录，这个目录不是工作区。改名后 `workspaceDirectory` 专指侧栏文件夹，头常量的名字就会误导人。

### 服务端

| 位置 | 现状 |
|---|---|
| `packages/ohbaby-server/src/coordination/session-project-move.ts:21-89` | `GlobalSessionCatalog.planMove(sessionId, projectDirectory)`、`SessionProjectMoveDeps`、`DefaultWorkspaceNotProjectError`（错误码 `DEFAULT_WORKSPACE_NOT_PROJECT`）、`moveSessionProject()` |
| `protocols/global-sessions.ts:22-26` | `toUiGlobalSession` 把 `session.projectRoot` 映射为 `workingDirectory` |
| `protocols/global-sessions.ts:69-83` | `parseSessionProjectUpdate` 读取 `body.projectDirectory`，错误消息 “projectDirectory must be a directory path or null” |
| `runtime/daemon/server.ts:308-309,689-722` | 路由 `POST /v1/sessions/:sessionId/project` 和处理方法 `moveSessionProject` |
| `runtime/daemon/server.ts:371-374,402,439` | `GET /v1/scopes` 响应里的 `defaultWorkspace: { directory }` |
| `runtime/daemon/server.ts:503-504` | “The default workspace cannot be opened as a project” |
| `runtime/daemon/main.ts:7-13,548,554-556` | 引入 `planSessionProjectMove` 等；`listKnownWorkspaceScopes: () => listKnownSessionProjectRoots()` |
| `runtime/daemon/server.ts:19-21,99,374,709` | 引入核心的 `ensureDefaultWorkspaceDirectory`、`isDefaultWorkspaceDirectory`、`SessionProjectMovePlan`；`WorkspaceBackend.adoptSessionProjectMove`（实现在核心 `adapters/ui-persistent.ts:116,823`） |
| `runtime/daemon/server.ts:499-506` | `POST /v1/scopes/open` 打开默认目录时也返回 `DEFAULT_WORKSPACE_NOT_PROJECT` |
| `protocols/web/routes/global-settings.ts:32,175`、`app/openapi.ts:403,408` | 设置“关于”接口的 `defaultWorkspace` 字段 |

服务端的 scope 命名（`resolveWorkspaceScope`、`/v1/scopes`、`/v1/scopes/open`、`/v1/scopes/hide`、`workspace_registry.scope_key`）表示“一个目录对应的运行实例”，含义没有问题。`main.ts:705` 的 `migrateOhbabyData({ projectDirectory })` 是数据迁移选项，属于 b 类。

OpenAPI 没有描述 `/v1/scopes*`、全局会话列表和移动路由，所以这几处契约改名不涉及 OpenAPI，只涉及“关于”接口的 `defaultWorkspace`。

### CLI

CLI 没有用到侧栏概念（没有 `projectDirectory`、`/v1/scopes`、`UiGlobalSession`）。它在 `tui/app.tsx:1234`、`tui/components/prompt/index.tsx`、`footer.ts` 读取 `activeSession.projectRoot` 显示在页脚，这是 a 类，会随 `UiSession` 改名。`/status` 面板里的 “Project” 显示的是宿主实例目录（b 类），不在本轮范围。

## 1.5 ohbaby-web（界面）

### 命名

| 位置 | 现状 |
|---|---|
| `apps/ohbaby-web/src/store/sidebar-groups.ts:16,25,35,49-59,73-181` | `SidebarProject`、`SidebarSessionItem.projectDirectory`、组 key `"no-project"` / `` `project:${dir}` ``、`SidebarProjectGroup`、`SidebarGroups.noProject`、`projectGroupKey`、`selectSidebarGroups` |
| `store/global-catalog.ts` | `projects`、`projectsStatus`、`setProjects`、`failProjects`、`removeProject` |
| `store/draft.ts:1-50` | sessionStorage key `ohbaby:draft-project:new`、`DraftSnapshot.projectDirectory`、`setProject` |
| `runtime/global-layer.ts`、`runtime/index.ts` | `refreshProjects`、`openDraft(projectDirectory)`、`moveSession(…, projectDirectory)`、`projectOf()` |
| `api/daemon/global-sessions.ts:49-58` | `POST /v1/sessions/:id/project`，请求体 `{ projectDirectory }` |
| `ui/sidebar/ProjectGroup.tsx`、`ProjectMenu.tsx`、`collapsed-projects.ts` | 组件、文件名、CSS 类 `ohb-project-*`（`sidebar.css` 17 处，`session.css` 7 处） |
| `ui/composer/ProjectPicker.tsx` | 草稿的文件夹选择器 |
| `dev/mock-runtime.ts`、`dev/mock-scenarios.ts` | mock 数据（`agentProject` 等，场景说明 “3 projects, 5 chats without a project”） |
| `ui/App.tsx:22-32`、`ui/composer/draft-storage.ts:71` | `legacyDraftProject` 及其注释 |

用户能看到的 project 文案共 16 处，包括 `Projects`、`No project`、`Hide project`、`Move to project`、`Remove from project`、`Choose a project`、`Open project`、`The default workspace is not available. Choose a project to start.` 等（`Sidebar.tsx:308,312,349`，`ProjectGroup.tsx:59,66`，`ProjectMenu.tsx:28`，`SessionMenu.tsx:43-44,59,93,179`，`ProjectPicker.tsx:28,67,87-88,93,111`，`AppController.tsx:286`，`DirectoryPickerDialog.tsx:173,185`）。

不属于本概念、不改的：`projectRunProcesses`、`slashCommands.ts:216` 的 `projectRoot`、Skills 设置里的 `"project-native": "Project"`、mock 设置里的 skill 来源 `"project"`。

### “No project” 分组的现状行为

- 在 `Sidebar.tsx:347-357` 渲染，位于 Pinned 和各项目分组之后，用通用的 `SidebarSection`，可以折叠，折叠状态存进 localStorage。
- 组里没有单独排序，沿用全局目录的顺序：`global-catalog.ts:143-150` 的 `sortSessions` 按 `updatedAt` 倒序，相同时按 `id` 倒序。Recents 需要的顺序已经有了。
- 先显示 `GROUP_PAGE = 6` 条，Show more 每次加 20 条（`SHOW_MORE_STEP`）；本地行不够时调用 `onLoadMore` 向服务端翻页。
- 没有手动拖动排序。`use-session-reorder.ts` 只是置顶变化时的过渡动画。

### 浏览器存储

| key | 存储 | 值里有没有 project 命名 |
|---|---|---|
| `ohbaby.web.sidebar.collapsed.v1` | localStorage | 有：数组元素形如 `"no-project"`、`"project:/abs/path"` |
| `ohbaby:draft-project:new` | sessionStorage | key 名里有，值是目录字符串 |
| `ohbaby.web.session-pins.v2:*` 等其余 key | localStorage | 没有 |

### 测试

需要跟着改的测试：`store/sidebar-groups.unit`、`store/draft.unit`、`ui/sidebar/Sidebar.unit`、`ui/shell/AppController.unit`、`ui/App.unit`、`ui/search/SidebarSearch.unit`、`ui/goal-resume.integration`、`runtime/session-runtime*.integration`（3 个）、`api/daemon/global-sessions.unit`、`api/daemon/command-lifecycle.integration`、`api/daemon/new-session-regression.integration`（直接写 `project_root` 的原始 SQL）、`ui/workspace/directory-picker/DirectoryPickerDialog.unit`，以及测试辅助 `runtime/fake-daemon.test-support.ts`（第 218 行用正则 `/project$/` 匹配移动路由）。

## 1.6 跨模块一致性

数据从数据库流到界面，要经过四次换名：

```
数据库 project_root ─▶ Session.projectRoot ─▶ UiGlobalSession.workingDirectory ─▶ Web workingDirectory
数据库 project_directory ─▶ Session.projectDirectory ─▶ UiGlobalSession.projectDirectory ─▶ 侧栏 “Projects”
服务端 workspace_registry.scope_key ─▶ GET /v1/scopes ─▶ Web catalog.projects
```

同一个文件夹，在服务端叫 scope，到 Web 又叫 project。`global-query.ts:111` 拿 `project_directory` 和 `workspace_registry.scope_key` 比较，在一行 SQL 里同时出现两种叫法。

## 1.7 改动影响面

| 层 | 涉及文件（约） | 风险 |
|---|---|---|
| 数据库迁移 | 2（`migrations.ts`、`schema.ts`） | 不可逆，旧版本无法读新库 |
| 核心会话领域 | 约 15 个源文件，外加约 70 个测试文件 | `ui-inprocess.ts` 里 a、b 两类混在一起；`SELECT *` 读取不受类型检查保护；公开导出改变 |
| SDK 与服务端契约 | 约 12 个源文件，约 7 个测试文件 | 公开包的不兼容变更 |
| CLI | 3 个源文件，约 5 个测试文件 | 只是跟着 `UiSession` 字段改名 |
| Web | 约 20 个源文件、14 个测试文件、2 个 CSS 文件 | 文案和浏览器存储 key |
| 权威文档 | `docs/ohbaby-web/redesign-2026-10/` 下 6 篇，另有 `docs/bus/event-catalog.md`、`docs/ohbaby-web/ui/components.md`、`docs/services/session/dfd-interface.md` | 与实现脱节；事件目录文档有契约测试 |

## 1.8 SWE 原则审视

- **命名是最便宜的文档，也是最贵的误导**（06 代码工艺）。`project_root` 的注释和名字说的是两回事，读者只看名字就会理解错，SDK 边界上的翻译就是证据。
- **一个概念一个名字**（02 基础受力：抽象一致性）。同一个文件夹叫 project、scope、workspace 三个名字，等于把信息分散到三个地方。
- **不对 `projectRoot` 做全局替换是有意的取舍**（03 KISS 与护栏）。b 类用法确实指 Git 根或配置目录，强行统一会制造新的错误命名。只改 a 类，依靠类型检查找出所有读写会话字段的地方，改动范围由编译器划定，而不是靠文本搜索。
- **不可逆决策要有回滚手段**（00 哲学：经济学视角）。改列名后旧版本读不了新库；迁移前的自动备份就是回滚路径，成本很低。
- **不为外观偏好写迁移代码**（03 YAGNI）。侧栏折叠状态丢一次的代价，小于维护一段转换代码的代价。

## 1.9 与既有文档的关系

| 文档 | 关系 |
|---|---|
| [无工作区会话与设置后端 improve-1](../../2026-10-20-workspaceless-sessions-and-settings/improve-1/02-optimization-plan-and-change-scope.md) | 行为来源。其中的移动路由和 `projectDirectory` 字段由本议题 02 取代；该文档是历史记录，不回改 |
| `docs/ohbaby-web/redesign-2026-10/01`、`02`、`03`、`04`、`05`、`06`、`08` | 前端设计的权威文档，定义了 No project、Projects、`projectDirectory`，Stage 4 同步 |
| `docs/bus/event-catalog.md:32-33` | 事件目录，`requiredContext` 写着 `session.projectRoot`，由契约测试比对，Stage 1 同步 |
| `docs/services/session/dfd-interface.md:39,134` | 会话服务接口说明，提到旧字段，Stage 4 同步 |
| `docs/ohbaby-web/ui/components.md:28` | 侧栏组件约定，写着 “Pinned、Projects、No project”，Stage 4 同步 |
| `docs/project/*` | 核心 Git 仓库身份模块，本议题之后 project 只指它，不改 |
| `redesign-2026-10/improve-1` 至 `improve-5` 的文档 | 历史记录，不回改 |
| `docs/ohbaby-web/{data-model,architecture,dfd-interface}.md`、`docs/ohbaby-server/*` | 没有出现本概念，不需要同步 |
