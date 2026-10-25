# 3. 参考项目借鉴

> 2026-10-25 由子代理只读调研，主代理整理。路径相对 `/Users/hansun025/Projects/code-cli/` 下的各项目根目录；未经运行验证的结论标注“推断”。

## 3.1 借鉴来源

| 项目 | 本地路径 | 调研范围 |
|---|---|---|
| opencode | `opencode/packages/core` | project 与 workspace 的定义、会话归档 |
| Codex（桌面端） | 用户提供的截图 | 侧栏的 Projects 与 Recents |
| deepseek-harness | `deepseek-harness` | Workspace 分组、无目录会话、字段演进 |
| kimi-code | `kimi-code` | workspace 领域对象、会话存储 |
| ZCode | `ZCode` | 目录与项目的分层、无项目会话、迁移方式 |
| pi | `pi` | 会话的目录字段、会话选择器 |

## 3.2 各项目怎么叫这个目录

| 项目 | 会话运行的目录 | 侧栏分组 | “项目”指什么 | 没有目录的会话 |
|---|---|---|---|---|
| opencode | 由 `Workspace` 提供（worktree 或远程环境，`src/workspace.ts`） | 按项目 | Git 仓库身份 | 不支持 |
| Codex | 文件夹 | Projects | 文件夹的集合 | 放在 Recents |
| deepseek-harness | `cwd` / `workingDirectory`（`packages/session/working-directory/src/index.ts:34-46`） | **Workspace**（`packages/workspace/workspace/src/spec.ts:24-30`） | 无 | 放在“未分组”，按时间排序 |
| kimi-code | `cwd`，归属于 **workspace**（`packages/agent-core-v2/src/app/workspace/workspace.ts:3`） | workspace → 会话树 | 无 | 不支持，创建时必须给目录 |
| ZCode | **`workspacePath`**（`packages/services/src/project-storage/contract.ts:48-52`） | Projects 与 Tasks 两段 | 虚拟容器，可挂多个目录 | 放在 Tasks，可切换为按时间排序 |
| pi | `cwd`（`packages/coding-agent/src/core/session-manager.ts:43-50`），界面上叫 Folder | 无分组，选择器可切换“当前文件夹 / 全部” | 无 | 不支持 |

## 3.3 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|---|---|---|
| deepseek-harness、kimi-code、ZCode | 用户选的目录叫 workspace，会话运行目录叫 `cwd` / `workingDirectory` / `workspacePath` | 和本议题的术语表一致 | **采纳**：workspace 和 working directory 两个名字 |
| opencode、ZCode | project 留给更高一层的概念（Git 身份或多目录容器） | ohbaby 核心 `project` 模块就是 Git 身份 | **采纳**：project 只指 Git 仓库身份 |
| deepseek-harness | 会话头部保存最初的目录，另记一个“当前运行目录” | 与 ohbaby 的 `working_directory` + `pending_working_directory` 思路相同 | 已有，**只改名** |
| Codex、ZCode | 无项目会话放在按时间排序的列表里，不作为一个“项目” | 用户要的就是这个 | **修订**：Recents 汇总全部可见活跃会话，以用户联合验收时的明确要求为准 |
| deepseek-harness | 存储格式每次变化都留一份带日期的记录，新字段用默认值兼容旧数据 | 本次改列名是不可逆变化 | **部分采纳**：用迁移注释和本议题文档记录；不另建持久化变更目录 |
| ZCode | 已发布的 SQL 迁移和校验值从不修改，用新迁移修正旧结果 | 本次不能改 `001`、`025` | **采纳**：只追加 `026` |
| pi | 会话文件按版本链式迁移（v1 → v2 → v3），读取时升级 | 说明“只追加、按序升级”是常见做法 | 参考，ohbaby 已有同类迁移运行器 |

## 3.4 明确不借鉴

| 做法 | 来源 | 不借鉴的原因 |
|---|---|---|
| 会话存储目录按工作区 ID 分开（`sessions/<workspaceId>/`） | kimi-code、pi | ohbaby 会话在 SQLite 里，归属只是一列；按目录分开会让“移动会话”变成搬文件 |
| 一个项目挂多个目录 | ZCode | 当前需求没有，属于过度设计 |
| 把 workspace 当作可创建、销毁的运行资源（driver） | opencode | ohbaby 的工作区就是本地文件夹，没有远程环境 |
| 旧字段名和新字段名并存、双写 | ZCode（旧设置项双写） | ohbaby 的客户端和 daemon 同版本发布，双写只会让两个名字长期并存 |

## 3.5 对 02 的影响

- 术语表（00 §2）直接来自 3.3 的前两行。
- Recents 的平铺形式参考了 Codex 和 ZCode；其范围按用户最新要求汇总全部可见活跃会话（02 Stage 3）。
- 只追加迁移、不改已发布迁移（02 Stage 1 第 1 步）参考了 ZCode。
- 归档相关的做法（deepseek-harness 恢复到原位置、ZCode 在 Settings 里做归档管理并强制“先归档才能删”）留给 `2026-10-25-archived-sessions` 议题。
