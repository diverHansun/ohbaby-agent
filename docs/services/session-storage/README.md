# session-storage（会话存储区）

本模块于 2026-11-04 设计。它给会话一个自己的文件目录，放 agent 的临时文件和产物，之后也放超长的工具输出。目录是 `~/.ohbaby/sessions/<ownerId>/`：子代理和 side chat 不单独建目录，直接用所属会话的那一份；fork 出来的会话有自己的。Web 端和以后的 App 端共用同一份存储。

名字说明：项目里 workspace（工作区）已经指“用户选的文件夹”，本模块因此叫“会话存储区”，英文 session storage。

## 文档地图

| 文档 | 内容 |
|---|---|
| [goals-duty](goals-duty.md) | 为什么要有它、负责什么、不负责什么 |
| [architecture](architecture.md) | 目录布局、和其他模块的关系、约束与取舍、实施分期 |
| [data-model](data-model.md) | 存储区、子目录、生命周期 |
| [dfd-interface](dfd-interface.md) | 目录怎么建、怎么被 agent 使用、怎么删除；对外接口 |
| [test](test.md) | 测试范围、关键场景、集成点 |

`use-case.md` 与 `non-functional.md` 跳过：本模块没有多步骤的业务编排；安全与磁盘占用这两条非功能约束写在 architecture 的约束一节。

## 已确认的决定

| 项 | 结论 | 来源 |
|---|---|---|
| 位置 | 放在 `~/.ohbaby/`（`OHBABY_HOME`）下，不放平台数据目录 | 用户 2026-11-04 确认 |
| 路径 | `~/.ohbaby/sessions/<ownerId>/`，不按工作区分组 | 用户确认。会话可以在工作区之间移动，按工作区分组就要搬目录 |
| 归属 | 目录按“所属根会话”分：子代理用根会话的目录，side chat 用主会话的目录，fork 出来的会话用自己的 | 文档审查发现子代理共用一个子会话；参考 claude-code 按主会话分 scratchpad，主会话与子代理共享 |
| 共用 | Web 端和以后的 App 端共用同一份存储 | 用户确认。两者连的是同一个 daemon |
| 默认目录 | 没选工作区的会话仍在共用的 `~/.ohbaby/workspace/default` 运行，规则不变 | 用户确认 |
| 子代理结果 | 数据目录里现有的 `storage/subagent-results/` 这一轮不搬 | 用户确认。用户计划在这几轮实施前单独调整它的位置，并参考 code-cli 下的项目 |
| 分期 | 第一期：目录、信任、告诉模型、随会话删除。第二期：超长工具输出存文件、右侧面板展示文件 | 用户确认 |
| 设计原则 | KISS，不过度设计 | 用户要求 |

## 与既有决定的关系

`docs/problem-lists/2026-07-14-ohbaby-home-unification/` 定过：数据库这类重数据放平台数据目录，不放 `~/.ohbaby/data/`。本模块不推翻它，边界是：

- 数据库、快照、子代理结果：程序内部数据，用户不会直接打开，仍在数据目录。
- 会话存储区：agent 写的、用户会看会打开的文件，放 `~/.ohbaby/`。

`docs/problem-lists/2026-10-10-compact-cache-and-tool-output/` 定过“不给所有工具强加统一的存盘服务”，当时卡在三件事上：Bash 输出在捕获时就被截断、MCP 没有统一入口、新文件没有读授权。本模块第一期解决读授权；第二期只给已经在截断输出的工具加存盘，Bash 单独改，MCP 不在本模块范围内。

## 相关议题

| 议题 | 关系 |
|---|---|
| [会话 fork](../../problem-lists/2026-11-04-session-fork/README.md) | fork 出来的会话有自己的存储区，不复制源会话的文件 |
| [side chat](../../problem-lists/2026-11-04-side-chat/README.md) | side chat 用主会话的存储区，能直接读主会话的文件；它写的文件留在主会话的存储区里，关闭 side chat 不删除 |
| [撤销重发](../../problem-lists/2026-11-04-conversation-undo/README.md) | 撤销不删除存储区里的文件，和“文件不回滚”一致 |
