# side chat

本议题于 2026-11-04 开启。目标是让用户临时问个问题、做件零碎小事，又不打扰主对话。side chat 是从主会话复制出来的隐藏会话：模型看得到主对话，界面上只显示 side chat 自己的内容，关闭后就删除。做法对照 codex 的 `/side`、`/btw`。

Web 通过右侧面板和“选中文字后在 side chat 里问”打开；TUI 新增 `/btw` 命令。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | Side Chat 后端、Web 面板与选中文字入口、TUI `/btw` | Stage 1 后端已验收（`c2e46a45`），Web 与 TUI 待实施 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 为什么不做成子会话、做成隐藏根会话要改哪些列表与操作、Web 多客户端、TUI 当前会话、边界消息、权限、清理的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 4、接口、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | codex、ZCode、kimi-code、claude-code、opencode、deepseek-harness 的做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| [05 后端实施与验收](improve-1/05-implementation-acceptance.md) | Stage 1 的交付范围、命令行端到端结果和恢复契约 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- **开发顺序**（2026-11-08 用户确认）：side chat → fork → 撤销重发。side chat 不依赖 fork：复制历史的函数 `copySessionHistory` 由本议题写（02 Stage 1 第 0 步），fork 以后直接调用。Stage 2（Web）用到的[消息复制议题](../2026-11-04-message-copy/README.md) `MessageActions` 已经落地。
- 分工在实施前与用户确认。
- 不可逆点：无。side chat 会话关闭即删除，不留数据。

## 相关议题

| 议题 | 关系 |
|---|---|
| [会话 fork](../2026-11-04-session-fork/README.md) | 在本议题之后实施，复用本议题写的 `copySessionHistory`；fork 挂按钮时遵守 `ConversationStream` 的 `side-chat` 开关，并在 fork 入口拒绝 side chat 会话 |
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 在 fork 之后实施：在撤销入口拒绝 side chat 会话，Edit 按钮遵守 `side-chat` 开关，并在 `copySessionHistory` 的切点与选行查询里加“跳过已撤销内容”的条件 |
| [消息复制](../2026-11-04-message-copy/README.md) | side chat 面板沿用它的 `MessageActions` 复制按钮 |
| [会话存储区](../../services/session-storage/README.md) | side chat 用主会话的存储区，能直接读主会话写的文件；关闭 side chat 不删除这些文件 |
| [已加载 MCP 工具从历史重建](../2026-11-09-mcp-loaded-tools-from-history/README.md) | 先于本议题实施。side chat 的已加载 MCP 工具和工具顺序由它保证，本议题不写 `copyScope` |
