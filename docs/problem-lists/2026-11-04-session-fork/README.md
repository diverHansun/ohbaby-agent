# 会话 fork

本议题于 2026-11-04 开启。目标是从某一轮已经结束的 AI 回答处，把会话复制成一个新会话：新会话带着到这一轮为止的全部历史，之后两边各走各的。做法参考 deepseek-harness。

Web 在每轮最终答案下面和会话行菜单里提供 fork，TUI 新增 `/fork`。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | fork 的后端、SDK、Web 两个入口、TUI `/fork` | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 会话创建、消息与 prompt 的存储、ID 引用、压缩、子代理引用的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 4、接口、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | deepseek-harness、ZCode、opencode、codex、kimi-code 的 fork 做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- Stage 2（Web）里“回答下面的 fork 按钮”依赖[消息复制议题](../2026-11-04-message-copy/README.md)的消息操作栏。
- 分工在实施前与用户确认。
- 不可逆点：无。fork 只新增会话，不修改源会话。

## 相关议题

| 议题 | 关系 |
|---|---|
| [消息复制](../2026-11-04-message-copy/README.md) | 提供消息操作栏 |
| [撤销重发](../2026-11-04-conversation-undo/README.md) | fork 复制历史时跳过已撤销的消息；两个议题谁后落地，谁负责补上这个条件 |
| side chat（`2026-11-04-side-chat`） | side chat 会复用本议题的复制逻辑来创建它的隐藏会话；side chat 会话本身不能再 fork |
| 会话存储区（`docs/services/session-storage/`） | fork 出来的会话有自己的存储区，不复制源会话的文件，规则在该模块里定 |
