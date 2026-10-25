# 讨论记录与已确认要点

> 2026-10-25 与用户讨论定稿。第 2 至 4 节是讨论中确认的结论；第 5 节是写规划时根据代码勘测补充、随后经用户审查确认的决定。推理过程见 [01](01-problem-analysis-and-current-state.md)，实施方案见 [02](02-optimization-plan-and-change-scope.md)。

## 1. 背景与动机

上一轮（[无工作区会话与设置后端](../../2026-10-20-workspaceless-sessions-and-settings/improve-1/00-discussion.md)）做完了“会话可以不选文件夹”的后端和 Web 接入，但沿用了 project 这个词：侧栏叫 Projects，没选文件夹的会话放在 No project 分组。

用户认为这个命名不对：

- 选一个文件夹作为根目录，本质上是选 workspace，正好对应终端里的工作路径。Cursor、Claude 桌面端都是“选文件夹”，并不把它叫 project。
- project 在 Cursor 里指云端服务，在 Claude 里指更高一层的项目，都不是“和 agent 对话所在的目录”。
- 会话应该能在指定 workspace 或没有 workspace 的状态下工作，并且可以移动。没有 workspace 的会话不再单独成组，而是像 Codex 一样放进按时间排序的 Recents。

勘测还发现，代码里 project 一词已经被核心 `project` 模块占用，专指 Git 仓库身份；会话上的 `project_root` 实际存的是运行目录。命名混用不只是界面问题。

## 2. 已确认：术语

| 术语 | 含义 | 代码中的名字 |
|---|---|---|
| workspace（工作区） | 用户选的文件夹，也是侧栏的分组 | `workspaceDirectory` / `workspace_directory` |
| working directory（运行目录） | 会话这一轮实际在哪个目录运行 | `workingDirectory` / `working_directory` |
| pending working directory | 换工作区后，下一轮要切换到的运行目录 | `pendingWorkingDirectory` / `pending_working_directory` |
| project | 只指 Git 仓库身份 | `projectId` 与核心 `project` 模块，保持不变 |
| default directory（默认目录） | 没有工作区的新会话实际运行的目录 | 代码改名为 default directory，磁盘路径 `<OHBABY_HOME>/workspace/default` 不变 |

“没有工作区”只表示会话不属于侧栏的任何分组，不表示它没有运行目录。新建的无工作区会话在默认目录运行；从工作区移出的会话继续在原目录运行。这条规则沿用上一轮结论，只换名字。

## 3. 已确认：范围

| 决策项 | 结论 |
|---|---|
| 数据库 | 新增迁移 `026`，一次改 3 个列：`project_directory` → `workspace_directory`，`project_root` → `working_directory`，`pending_project_root` → `pending_working_directory`。不支持降级 |
| 核心代码 | 只改会话领域里的 `projectRoot`（会话类型、store、manager 和直接读写这些字段的地方），不对 `projectRoot` 做全局替换 |
| SDK 与 REST 契约 | 字段和类型直接改名，不保留旧名字的兼容层 |
| 默认目录 | 代码里的 default workspace 改叫 default directory，磁盘路径不变 |
| Web 命名 | `Projects` → `Workspaces`，`Hide project` → `Hide workspace`，草稿选择器显示 `No workspace`，其余菜单文案同步 |
| Web Recents | `No project` 分组改为侧栏底部的 Recents：包含所有可见活跃会话（含工作区与置顶会话），按更新时间倒序，不能折叠 |
| 分批 | 同一轮内分 4 个 Stage：存储层与核心；服务端与 SDK 契约；Web；文档同步。每个 Stage 结束时类型检查和测试保持通过 |
| 分工 | Stage 1、2 由用户实施；Stage 3、4 由 agent 在后端完成后实施 |
| 关键改动清单 | 用户要求写入 02 |
| 文档落点 | `docs/problem-lists/2026-10-25-workspace-naming/improve-1/`；归档管理另起 `2026-10-25-archived-sessions/`，本议题完成后再规划 |

## 4. 已确认：边界

| 项 | 处理 |
|---|---|
| 会话归属、移动、目录切换、搜索的行为 | 不变，只改名字 |
| 核心 `project` 模块与 `projectId` | 不动 |
| 归档会话的恢复与永久删除 | 不在本议题，见 `2026-10-25-archived-sessions/` |
| 默认目录的磁盘路径 | 不动，避免搬用户文件 |
| 模块级 `improve-N/` 文档 | 不写；受影响的权威文档在 Stage 4 直接同步 |

## 5. 规划中补充的决定

以下几点是勘测时发现、讨论阶段没有覆盖到的，理由见 01 和 02。2026-10-25 随整套文档提交用户审查并确认。

| 编号 | 决定 | 一句话理由 |
|---|---|---|
| P1 | `ohbaby-sdk` 和 `ohbaby-agent` 都是 npm 公开包（SDK 当前 0.1.16），仍按 0.x 规则直接改名，在发布说明里写明不兼容变化和公开导出的改名对照表（见 02 §2.3），不加旧字段别名。用户 2026-10-25 确认 | 没有已知的外部使用者；0.x 版本允许不兼容变更；别名会让新旧两个名字长期并存 |
| P2 | 迁移 `026` 设置 `requiresOfflineBackup: true`，并把后台 daemon 的 PID（`<OHBABY_HOME>/server/daemon.pid`）作为 `knownWriterPids` 传给数据库初始化；发布说明要求升级前退出所有 ohbaby 进程 | 现有机制只能发现“正在跑任务”的进程，空闲的旧 daemon 会漏掉，升级后它会报 “no such column”。补上 daemon PID 能覆盖最常见的情况；空闲的旧 TUI 仍然发现不了，只能靠发布说明。升级前的自动备份是回滚手段 |
| P3 | 请求头常量 `WORKSPACE_DIRECTORY_HEADER` 等改名为 `REQUEST_DIRECTORY_HEADER` 等，头的取值 `x-ohbaby-directory` 不变 | 这个头带的是请求要路由到的目录，不一定是工作区；不改名会和新的 `workspaceDirectory` 撞名 |
| P4 | 引擎层的 `projectRoot` 参数（agent 运行、生命周期、上下文、`OHBABY.md` 查找）本轮不改；会话导出文件格式里的 `session.projectRoot` 本轮不改 | 前者在引擎里表示“本轮按哪个目录找项目配置”，后者是已发布的文件格式，改它要升版本并处理旧文件；两者都登记为后续候选 |
| P5 | 服务端内部的 scope 命名（`resolveWorkspaceScope`、`/v1/scopes`、`workspace_registry.scope_key`）不改 | scope 表示“一个目录对应的运行实例”，含义本来就对；路由路径里没有 project |
| P6 | Web 折叠状态的 localStorage key 升到 `v2`，删除旧 key、不转换旧值（Pinned 的折叠状态也会一起重置）；草稿的 sessionStorage key 改为 `ohbaby:draft-workspace:new` | 折叠状态只是外观偏好，丢一次的代价是分组全部展开；为它写转换代码不划算 |
| P7 | 移动接口路径 `POST /v1/sessions/:sessionId/project` 改为 `POST /v1/sessions/:sessionId/workspace` | 契约里不再出现 project；路由和请求体一起改 |

## 6. 参考项目

调研了 opencode、Codex、deepseek-harness、kimi-code、ZCode、pi。没有一家把“用户选的文件夹”叫 project：deepseek-harness、kimi-code、ZCode 叫 workspace，pi 叫 cwd / Folder。详见 [03](03-reference-projects.md)。
