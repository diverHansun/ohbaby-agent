# 消息复制

本议题于 2026-11-04 开启。目标是让 Web 上的用户消息、AI 的最终答案和代码块都能一键复制，复制的内容只有正文，不带思考过程和工具执行过程。

本议题只改 Web，TUI 不新增复制命令。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | Web 消息操作栏、剪贴板工具、用户消息与最终答案复制、代码块复制 | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | Web 消息渲染、最终答案判定、剪贴板、Markdown 渲染的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 2、改动面、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | deepseek-harness、ZCode、kimi-code、opencode 的复制做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- 分工在实施前与用户确认。

## 相关议题

同一批（2026-11-04）还有四个议题，各自独立成册：

| 议题 | 关系 |
|---|---|
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 它的 Edit 按钮挂在本议题搭好的消息操作栏上，应在本议题之后实施 |
| [会话 fork](../2026-11-04-session-fork/README.md) | 它的 fork 按钮挂在本议题的消息操作栏上 |
| [side chat](../2026-11-04-side-chat/README.md) | side chat 面板沿用本议题的 `MessageActions` 复制按钮，它的 Web 部分应在本议题 Stage 1 之后实施 |
| 会话存储区（`docs/services/session-storage/`） | 无直接依赖 |
