# 1. 现状与问题分析

> 代码基线为 `73f12b63`（0.1.16），2026-10-20 调研，2026-10-21 补充核对；尚未实施。本文写当前代码与缺口，方案在 [02](02-optimization-plan-and-change-scope.md)。行号是读取时的快照，定位以符号为准。

## 1.1 问题陈述

1. **Web 端不选目录就不能对话。** 实例内请求要带 `x-ohbaby-directory`，缺了返回 400；Web 端 `selectedDirectory === null` 时不渲染会话界面。点击新会话还会立即在当前目录创建，无法先写草稿再选项目。
2. **会话列表是"单目录视角"。** 后端只能列出当前目录的会话，没有跨项目的接口；Web 端一次只连一个目录的客户端。要做"按项目分组的侧边栏"，现有数据取不全。
3. **设置模块不存在。** 配置散落在 `~/.ohbaby/` 下的 `model.json`、`mcp/settings.json`、`tools/search.json` 等文件里，运行时状态靠斜杠命令查看。Web 端没有统一入口，而且 MCP 的失败原因和工具数量在传给界面前被丢掉了。
4. **项目归属与工作目录没有分开。** 当前 `project_root` 同时承担执行目录和会话分组依据，无法表达“移出项目，但仍在原目录工作”。
5. **没有全局正文搜索。** 现有会话索引无法完成跨项目、跨历史的标题与可见正文搜索。

## 1.2 已确认的产品/技术分界

引用 [00](00-discussion.md)：

- 新建时未选项目，使用固定默认工作区运行普通 agent，没有单独模式。
- 草稿第一次发送才创建会话。已有会话可调整归属，换项目在下一轮使用目标目录；移出项目保留工作目录。
- 搜索覆盖未归档根会话的标题和用户、助手可见正文。
- 前端本轮只给大致布局。

```
现状                                  目标
请求 ──x-ohbaby-directory──▶ 实例       目录头路由不变，值取会话的实际执行目录
缺头 → 400                            新草稿未选项目首次发送 → 默认目录
Web 无目录 → 无法开始对话               已有会话移出项目 → 保留原目录
```

## 1.3 ohbaby-server 现状

### 1.3.1 路由分两层

`packages/ohbaby-server/src/runtime/daemon/server.ts` 的 `mountRoutes`（约 L224–L256）：

| 层 | 路由 | 是否要目录头 |
|---|---|---|
| daemon 全局层 | `GET /v1/scopes`、`POST /v1/scopes/open`、`POST /v1/scopes/hide`、`/v1/directory-picker/*`、`GET /v1/connections` | 否，只校验 Bearer token |
| 按工作区分发 | `/api/rpc`、`/api/events`、`/v1`、`/v1/*` | 是，走 `dispatchWorkspaceRequest`（约 L550） |
| 兜底 | `*` | 否，走初始 scope，主要用来提供 Web 静态资源 |

分发逻辑：取头 → `InstanceStore.load(directory)` → `resolveWorkspaceScope` → 交给该实例自己的 Hono app（`create-app.ts`）。缺头时 `resolveWorkspaceScope` 抛 `directory-required`，返回 400（`runtime/workspace-scope.ts:28`）。

JSON-RPC 的 40 个方法（`protocols/jsonrpc/protocol.ts:3-45`）全部经 `/api/rpc`，所以全部要头。

### 1.3.2 scope 的解析规则

`resolveWorkspaceScope`（`runtime/workspace-scope.ts`）要求绝对路径、存在、可读、是目录，然后用 `Project.getProjectRoot` 向上找 `.git`：找到就用仓库根，找不到就用目录自己。它不创建目录。

这意味着：默认工作区放在一个**不在任何 git 仓库内**的位置时，scope 就是它本身。但如果用户的 `$HOME` 本身是 git 仓库（例如用 git 管理 dotfiles），`~/.ohbaby/workspace/default` 会被向上归并成 `$HOME`。这是已证实的行为，不是推测（`getProjectRoot` 逐层向上，见 `project/project-manager.ts:33-49`）。

### 1.3.3 scope 列表的来源

`GET /v1/scopes`（`server.ts` 约 L302）合并三类来源：已加载的实例、`listKnownSessionProjectRoots()`（`session` 表里去重的 `project_root`）、`workspace_registry` 表（`visibility`、`position`、`lastOpenedAt`）。默认工作区一旦产生会话，就会出现在 `listKnownSessionProjectRoots()` 里，从而被当成普通项目列出。

### 1.3.4 每个实例创建什么

已证实：每个 scope 一个独立 Hono app；`adapters/ui-persistent.ts`（约 L644 起）为它创建一套 `sessionManager` / `messageManager` / `runLedger`，并在启动时恢复该 scope 里 `active` 的会话（约 L712）；`adapters/ui-runtime/composition.ts` 创建按 workdir 的 sandbox 管理器（约 L433）和按目录取单例的 `McpManager`（`McpManager.getInstance`，约 L1063）。

在现有实现下，给每个会话分配独立 scope 会增加实例及 MCP 的数量。本轮采用共享默认目录，不改成每会话一个目录。

### 1.3.5 没有全局会话接口

全局层只有 scopes、directory-picker、connections。`/v1/sessions/index` 和 RPC `getSessionIndex` 都按实例过滤。`persistent-store.ts` 中的 `getSessionIndex` 返回当前目录全部活跃根会话，没有分页；不能靠它补齐新的全局列表与搜索。

## 1.4 ohbaby-agent 现状

### 1.4.1 会话与项目

- 会话表 `session`（`services/database/schema.ts`）有 `project_id`、`project_root` 两列，整个应用共用一个数据库 `~/.ohbaby/ohbaby.db`。跨项目查询可以直接使用现有数据，但新增项目归属仍需要持久化与旧数据兼容。
- 索引有 `idx_session_project_updated(project_id, updated_at)` 和 `idx_session_parent(parent_id)`（`database/migrations.ts:21-22`），没有 `updated_at` 单列索引。
- `Project.fromDirectory`（`project/project-manager.ts:56`）对非 git 目录返回 `project_id = "global"`，`rootPath` 为目录本身。所有非 git 目录共用这个 ID，因此不能把它当成侧栏项目归属。移出项目后仍保留目录，也意味着不能通过“目录是否等于默认目录”判断无项目。
- `listByProjectRoot`（`services/session/database-store.ts:392`）是把整张表读出来，再在内存里按 `project_root` 过滤。数据量小的时候没问题，是一个已存在的性能隐患，本轮不改。
- 现成的全局查询：`getRecent(limit)`（约 L477）不限项目，按 `updated_at` 倒序，只返回 `parent_id IS NULL` 的根会话，但**没有 status 过滤**，归档会话也会返回。
- 会话 ID 是主键，消息和运行记录通过它关联。`database-store.ts:500` 已能更新项目字段，但公开的 `UpdateSessionPatch`（`services/session/types.ts:52`）未开放这些属性，也没有跨实例移动流程。
- 与会话移动相关的现有状态：
  - 排队消息存在 `prompt_submission` 表，领取时同时校验 `scope_key`、`owner_id`、`owner_pid`；每个实例有独立的 `backendOwnerId`。只改目录不足以交接队列。调度器只在本实例内被触发，加载时会处理一遍队列（`runtime/prompt-scheduler/database-store.ts:484,612`、`ui-persistent.ts:667`、`scheduler.ts` 的 `init`）。
  - 同一会话不会被两处同时执行：`runtime/run-ledger/database.ts` 的 `claimPendingRun` 在事务里检查该会话有没有正在运行的轮次，有就抛 `SessionRunBusyError`，调度器把消息放回队列后延迟重试。这个检查走数据库，跨实例、跨进程都有效。
  - 权限级别与模式按实例保存，会话级放行规则只在实例内存里（`permission/state.ts`）。
- `data` JSON 只编码规定的字段，并非任意数据透传（`database-store.ts:87`）。无论增加列还是扩展现有存储，都需要调整映射并处理旧数据，不能承诺“数据库无迁移”。

### 1.4.2 非 git 工作目录会怎样

| 模块 | 对非 git 目录的行为 | 来源 |
|---|---|---|
| 快照 | 用独立的影子 git 仓库（`snapshotRoot`），不依赖项目自己有 `.git`，非 git 目录可用 | `snapshot/diff-engine.ts` `GitSnapshotEngine` |
| 沙箱 | 可信根 = 工作区目录本身，其余路径走外部审批 | `sandbox/trusted-roots.ts` |
| 系统提示词 | `detectEnvironment` 向上找 `.git` 来填 `Git repository: true/false`；`$HOME` 是仓库时会误报 true | `core/system-prompt/layers/environment.ts:detectEnvironment` |
| 项目级配置 | 在工作区目录下找 `.ohbaby/`，默认目录下没有就是空 | `paths/ohbaby-home.ts:resolveProjectOhbabyRoot` |

非 git 目录已有运行基础。默认目录需要避免被父级仓库吞并，新的会话移动还需要处理下一轮执行目录的交接。快照属于工作区级能力，当前 daemon Web 没有开放恢复入口，本轮不把它扩展成新的 Web 功能。

### 1.4.3 配置与运行时状态

| 配置 | 文件 | 加载/写入 |
|---|---|---|
| 模型 | `~/.ohbaby/model.json`（`provider`、`defaultModel`、`apiConfig`、`llmParams`、`models`） | 读 `config/llm/loaders.ts`；写 `setActiveLLMConfig`（`config/llm/writer.ts:222`） |
| MCP | `~/.ohbaby/mcp/settings.json` + 项目级 | 只有读（`config/mcp/loaders.ts`），没有写入接口 |
| Agents | 全局 + 项目级 settings | 只有读（`config/agents/loaders.ts`）；注册表有 `list()`（`agents/registry.ts:120`） |
| Skills | 全局 + 项目级目录 | 注册表有 `listUserInvocable()`（`skill/registry.ts:75`） |
| 联网搜索 | `~/.ohbaby/tools/search.json`，真实 key 在 `~/.ohbaby/.env` | 配置保存变量名；写入 key 走 `/v1/settings/search-api-key` |

模型配置目前只保存一套活跃连接。`listModels` 返回当前项或空列表（`adapters/ui-inprocess.ts:2602`），`model.json` 的 `models` 是模型能力等元数据，不能当成多套 provider 连接。现有 `UiCurrentModelConfig` 与 `connectModel()` 足够支持第一版查看和编辑。

MCP 运行时状态在 `McpManager.getStatus()` 里是完整的：`connected`（带 `toolCount`）、`failed`（带 `error`）、`disconnected`、`disabled`（`mcp/types.ts:9-12`）。但转成命令层摘要时只留了 `{ name, status }`：

- `adapters/ui-runtime/composition.ts:264-266` 映射函数
- `commands/types.ts:52` `CommandMcpServerSummary`
- `commands/normalize.ts:54` `sanitizeCommandMcpServerSummary`

`McpManager` 没有增删服务器、重连的公开方法（公开方法见 `mcp/core/manager.ts`：`getAllTools`、`listResources`、`getStatus` 等）。

`getAllTools()` 已应用工具过滤规则；工具项带有 `name`、`description`、`mcpServer`、`mcpToolName`（`mcp/integration/tool-adapter.ts:115`）。`getStatus()` 的工具数来自服务器原始列表，所以“已加载工具数量”应按过滤后的工具列表统计。

`AgentRegistry.list()` 能提供有效配置，但当前没有保留 `builtin/source/scope` 来源信息，不能按名称猜测。来源标签若要返回，需在加载时保留真实元数据。

`/status` 命令（`commands/builtin.ts:258`）已经汇总了模型、权限、工具数、skill 数、MCP 摘要、诊断文件路径，但它是命令输出，不是结构化的设置接口。

### 1.4.4 凭据

模型和搜索配置都通过环境变量名引用 key，真实值写入全局 env 文件。设置快照只需返回“已配置/未配置”和变量名；还要过滤诊断错误中的凭据，不能直接透传配置对象或原始错误文本。

## 1.5 ohbaby-web 现状

> 本节只为框定前端改动的范围，不做细致分析。

- `apps/ohbaby-web/src/ui/App.tsx:46`：`workspace.selectedDirectory === null`（或客户端还没建好）时渲染 `EmptyWorkspaceApp`（"Open a project to get started"，约 L104）。
- `ui/workspace/ProjectRail.tsx`：opencode 风格的图标栏，一个目录一个图标。
- `runtime.ts`：持有一个 `workspaceSnapshot`（`scopes` + `selectedDirectory`）和一个 `activeClient`。**整个运行时按"当前选中的一个目录"组织**，切换目录要重建客户端。
- 浏览器本地存储 `ohbaby.web.navigation.v1`（`api/daemon/navigation-state.ts`）记 `selectedDirectory` 和每个目录最近打开的会话。
- `ui/session/SessionSidebar.tsx`：只显示当前目录的会话；已有本地置顶（`session-pins.ts`）和拖拽排序（`use-session-reorder.ts`）。
- `ui/composer/Composer.tsx`：输入框区域没有项目选择控件。`runtime.ts:137` 点击新会话就调用创建接口，使用当前选中目录，没有本地草稿阶段。
- `SessionSidebar` 没有全局会话搜索；现有服务端索引也不返回正文命中信息。
- 斜杠命令 `/models`、`/mcps`、`/skills`、`/status` 的输出用通用浮层渲染（`ui/commands/`），不是设置页。
- 与目录切换相关的集成测试很多（如 `api/daemon/workspace-switch.integration.test.ts` 753 行），重构 `runtime.ts` 会连带它们。

## 1.6 文档与实现的对照

| 文档说 | 代码做 | gap |
|---|---|---|
| [全局单 Daemon](../../2026-07-11-global-single-daemon/README.md)：全局 serve + `InstanceStore` + 请求级目录头 | 与代码一致（本文 §1.3） | 补默认工作区与会话跨目录衔接，沿用目录路由 |
| [多项目运行时](../../../ohbaby-server/hono-app/04-multi-project-runtime.md) 是目标态权威 | 未逐条核对 | 工作区批次完成后需同步，核对留到实施时 |

## 1.7 跨模块一致性

- 当前 `project_root` 在 agent、server、web 三处都影响执行与分组。后续需要将项目归属单独持久化，Web 不能用侧栏归属推算请求目录。
- 默认目录由服务端根据实际 ohbaby home 统一解析，并通过接口返回；Web 不自己拼路径。
- `InstanceStore` 的 scope key 是 `resolveWorkspaceScope` 的输出，默认工作区的 scope key 必须等于会话表里写入的 `project_root`，否则全局索引会和实例对不上。

## 1.8 改动影响面（现状视角）

- 服务端：全局路由层、`resolveWorkspaceScope`、`/v1/scopes` 的合并逻辑。
- Agent：`paths`、会话存储与跨实例续聊、全局列表及正文查询、MCP 摘要和设置聚合。
- SDK：新增的响应类型与客户端方法。
- Web：`App.tsx`、`runtime.ts`、`ProjectRail`、`SessionSidebar`、`Composer`，新增设置面板。
- TUI：不改交互，但会话存储、模型配置和 `commands` 等共用代码需要回归。

## 1.9 SWE 原则审视摘要

| 发现 | 依据 | 判断 |
|---|---|---|
| Web 强依赖当前目录，项目归属与执行目录共用一个概念 | 新草稿、移出项目保留目录都难以表达 | 将必需的两个概念分开，不另建项目管理系统 |
| 数据库已经是全局的，只有服务层按目录切开 | 信息隐藏做得对：数据层没被目录模型绑死 | 好的设计，跨项目查询成本低 |
| MCP 运行时状态完整，到命令层被丢掉 | 在边界处丢失信息，下游无法补回 | 客观问题，补字段即可，不需要新抽象 |
| 设置分散在 5 个配置文件里，没有统一读取入口 | 关注点分离做得对，但缺少聚合层 | 不引入统一"设置存储"，只做薄的只读聚合（KISS） |
| `listByProjectRoot` 全表读取后内存过滤 | 隐性性能债务 | 权衡：当前量小，本轮只在新接口里避免重复这个模式 |

本轮按 KISS 补齐这些已确认的缺口，不因少见的后台任务情况扩大运行时设计。

## 1.10 与既有文档关系

- 与 [全局单 Daemon](../../2026-07-11-global-single-daemon/README.md) 不冲突，是在它之上增加一个固定的 scope。
- 与 [Web 会话侧栏整理](../../2026-09-30-web-session-sidebar/README.md) 有重叠：该议题定义了旧侧栏的"圆点、Recent sessions、常驻归档和 footer"，本轮的分组方式会覆盖其中与"单目录"相关的部分，需要在其 README 里加一行"被后续议题部分取代"的说明（实施时做）。
