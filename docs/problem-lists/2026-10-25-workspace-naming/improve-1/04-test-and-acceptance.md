# 4. 测试与验收标准

> 验收会话按本文逐项核对。测试文件命名沿用仓库规则：`*.unit.test.ts`、`*.contract.test.ts`、`*.integration.test.ts`。命令都在仓库根目录执行。

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 集成测试 | 迁移 `026` 的升级与保护、会话存储、全局列表、移动会话、目录切换、REST 路由 |
| 契约测试 | SDK 与适配层输出的字段名 |
| 单元测试 | Web 侧栏分组计算、浏览器存储 key、文案 |
| 浏览器走查 | Web 侧栏、草稿选择器、会话菜单的实际表现 |
| 文本检查 | 用 `rg` 确认旧名字只留在允许的位置 |

改名的风险主要不在“名字没改全”（类型检查能发现），而在两处：手写 SQL 里的列名，以及 `ui-inprocess.ts` 里把宿主目录误当成会话目录。测试重点放在这两处。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
|---|---|---|---|---|
| T1 | 从 `025` 升级到 `026` | 集成（新增，参照 `retained-migration.integration.test.ts` 和 `project-binding.integration.test.ts:107-113` 的写法） | 先只跑到 `025` 并写入 3 种会话：有工作区、无工作区、有待切换目录；执行 `026` 后，3 个新列的值与旧列一致；旧列名不存在（`PRAGMA table_info(session)`）；`database.integration.test.ts` 的版本列表包含 `026` | 1 |
| T2 | 升级保护 | 集成 | 只差 `026` 一个迁移时也会触发备份；`daemon.pid` 指向一个存活的其他进程时抛出 `DatabaseUpgradeBlockedError` 且不改表；`daemon.pid` 指向当前进程或不存在时正常升级。`022` 的通用机制已有测试，不重复 | 1 |
| T3 | 会话存储与目录切换 | 集成（现有测试改名后通过，另加一条断言） | 创建、读取、`recordWorkingDirectory`、移动到工作区、移出工作区、待切换目录在下一轮生效后清空，行为与改名前一致；新增断言：从真实数据库行读出的 `Session` 中 3 个字段都有值（防止 `SELECT *` 漏改后读出 `undefined`） | 1 |
| T4 | 全局列表与隐藏工作区 | 集成（`global-query.integration`） | 隐藏工作区里的会话不出现在普通列表，搜索仍能找到；从隐藏工作区目录移出的会话仍在列表里 | 1 |
| T5 | 配置目录没有被误改 | 集成（`ui-runtime/custom-instructions.integration`、`adapters/session-project-move.integration` 改名后通过） | 会话移到工作区 B 后，下一轮从 B 读取 `OHBABY.md` 和项目配置；当前轮仍用原目录 | 1 |
| T6 | Stage 1 对外不变 | 契约（`ui-inprocess.contract`、`bus/event-catalog.contract` 等） | Stage 1 结束时 `UiSession.projectRoot`、`UiGlobalSession.projectDirectory` 的输出值与改名前相同；事件目录代码与 `docs/bus/event-catalog.md` 一致 | 1 |
| T7 | 移动路由 | 集成（服务端） | `POST /v1/sessions/:id/workspace` 带 `{ workspaceDirectory: "/abs" }` 成功；`null` 表示移出；传默认目录返回 400 和 `DEFAULT_DIRECTORY_NOT_WORKSPACE`；请求体用旧字段 `projectDirectory` 返回 400；旧路径 `/project` 返回 404 | 2 |
| T8 | 目录与设置接口 | 集成 | `GET /v1/scopes` 和 `GET /v1/settings/about` 返回 `defaultDirectory`，不再有 `defaultWorkspace`；`POST /v1/scopes/open` 打开默认目录返回 400 和 `DEFAULT_DIRECTORY_NOT_WORKSPACE` | 2 |
| T9 | 快照字段 | 契约 | `UiSession.workingDirectory`、`UiSessionIndexEntry.workingDirectory`、`UiGlobalSession.workspaceDirectory` 有值；旧字段不存在；TUI 页脚显示运行目录 | 2 |
| T10 | 侧栏分组 | 单元（`store/sidebar-groups.unit`） | 分组顺序是 Pinned → 各工作区 → Recents；Recents 只含 `workspaceDirectory === null` 且未置顶的会话，按 `updatedAt` 倒序；本地没有这类会话**并且**服务端没有更多页时 `recents` 为 `null`，本地没有但还有更多页时仍然显示（保留 Show more 入口）；分页与 Show more 和改名前一致 | 3 |
| T11 | 侧栏渲染 | 单元（`ui/sidebar/Sidebar.unit`） | 标题 `Workspaces` 和 `Recents`；Recents 没有折叠按钮；工作区菜单显示 `Hide workspace` | 3 |
| T12 | 浏览器存储 | 单元 | 折叠状态读写 `ohbaby.web.sidebar.collapsed.v2`；存在 v1 时不报错、不读取，并把 v1 删除；草稿读写 `ohbaby:draft-workspace:new` | 3 |
| T13 | 浏览器走查 | 手工（mock 的 `typical` 场景和真实 daemon 各走一遍） | 见 4.5 发布门第 6 项 | 3 |
| T14 | 文档同步 | 文本检查 | `rg -n "No project\|projectDirectory\|/project\b\|ProjectPicker\|ProjectGroup\|Projects" docs/ohbaby-web/redesign-2026-10/0*.md docs/ohbaby-web/ui/components.md docs/services/session/dfd-interface.md` 没有本概念的命中 | 4 |

## 4.3 集成边界

| 边界 | 风险 | 对应用例 |
|---|---|---|
| SQLite 迁移运行器 | 迁移失败导致 daemon 起不来 | T1、T2 |
| 手写 SQL（`database-store.ts`、`global-query.ts`） | 运行时才报 “no such column” | T1、T3、T4 |
| 核心会话 → 引擎层 `projectRoot` 参数 | 配置从错误目录加载 | T5 |
| 核心 → SDK 适配层 | 字段漏映射，界面拿到 `undefined` | T6、T9 |
| daemon REST ↔ Web 接口层 | 路由或请求体不一致 | T7、T8 |
| daemon JSON-RPC ↔ TUI | 页脚显示空白 | T9 |

## 4.4 回归清单

以下行为必须和改名前完全一致：

- 新建会话：不选工作区时在默认目录运行；选了工作区时在该目录运行。
- 运行中的会话移到另一个工作区：当前轮不受影响，下一轮切到目标目录，排队的消息跟着走。
- 移出工作区：保留当前运行目录，取消尚未生效的切换。
- 子代理会话继承父会话的工作区。
- 隐藏工作区、重新打开工作区、全局搜索、置顶、归档。
- 会话导出文件的格式和 `version: 1` 不变，`session.projectRoot` 字段仍然存在且值是运行目录。
- TUI 在启动目录工作的方式不变。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|---|---|---|
| 1 | 类型检查通过 | `pnpm typecheck` |
| 2 | 测试全部通过 | `pnpm test:unit`、`pnpm test:contract`、`pnpm test:integration` |
| 3 | 旧列名只留在已发布迁移和迁移测试里 | `rg -n "project_root\|project_directory\|pending_project_root" packages apps --glob '!**/dist/**'` |
| 4 | 契约里没有本概念的 project 命名 | `rg -n "projectDirectory\|UiSessionProjectUpdate\|DEFAULT_WORKSPACE_NOT_PROJECT\|WORKSPACE_DIRECTORY_HEADER\|defaultWorkspace" packages/ohbaby-sdk/src packages/ohbaby-server/src apps/ohbaby-web/src --glob '!**/dist/**'`，剩余命中逐条确认属于 b 类 |
| 5 | Web 没有用户可见的 project 文案（Skills 来源除外） | `rg -n "[Pp]roject" apps/ohbaby-web/src --glob '!**/*.test.*'`，逐条对照 01 §1.5 的“不属于本概念”清单 |
| 6 | 浏览器走查 | 侧栏显示 Workspaces 和底部的 Recents；Recents 不能折叠、按时间排序；把 Recents 里的会话移到工作区后它离开 Recents；从工作区移出后回到 Recents；草稿选择器显示 `No workspace`；手机宽度下侧栏正常 |
| 7 | 真实数据库升级 | 拿一份改名前的数据库副本启动新 daemon：生成备份文件，侧栏会话和工作区与升级前一致 |
| 8 | 发布说明 | 写明 `ohbaby-sdk` 和 `ohbaby-agent` 的不兼容变化、改名对照表、“不能降级，回退需用备份”、“升级前退出所有 ohbaby 进程”、“升级后刷新已打开的 Web 页面” |

## 4.6 对抗性审查要点

| 攻击面 | 可能的错误 | 防御 | 残余风险 |
|---|---|---|---|
| `ui-inprocess.ts` 的混合表达式 | 把宿主目录变量改成会话字段，或反过来 | 先改类型、按编译错误修；评审逐条看这个文件的 diff；T5 | 两个值碰巧相同时测试发现不了，靠评审 |
| 手写 SQL | 漏改列名，或 UNION 里的别名没跟着改 | Stage 1 完成定义的 `rg` 检查；T1、T3、T4 | 低 |
| 升级时有别的 ohbaby 进程 | 旧 daemon 或旧 TUI 还在跑，迁移后写库报错 | `requiresOfflineBackup` 能发现有运行中任务的进程；`daemon.pid` 能发现空闲的旧 daemon；T2 | 空闲的旧 TUI 发现不了，它下次写会话时会报错，需要重开；写进发布说明 |
| 未刷新的旧网页 | 旧页面读不到 `projectDirectory`，侧栏分组出错 | 发布说明要求刷新 | 用户没看发布说明时会遇到一次报错，刷新后恢复 |
| 回退 | 用户装回旧版本后 daemon 起不来 | 升级前自动备份 | 备份之后产生的新会话会丢失；写进发布说明 |
| Web 存储 key | 旧 v1 值格式不对导致崩溃 | 不读 v1；T12 | 低 |
| Recents 和置顶 | 置顶的无工作区会话同时出现在 Pinned 和 Recents | 沿用“置顶的会话只出现在 Pinned”的规则；T10 | 低 |
