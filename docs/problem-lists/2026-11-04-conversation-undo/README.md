# 撤销重发

本议题于 2026-11-04 开启。用户把这项功能叫“编辑重发”：对已经发出的消息，撤销它和之后的几轮对话，改完再发。Web 在消息气泡里直接改，点 Send 时撤销和发送一次做完；TUI 把原文填回输入框，用户改完自己发。会话在运行时，后端先停下来再撤销。被撤销的内容留在数据库里，但模型和界面都看不到；文件改动不回滚。

Web 在用户消息上放 Edit 按钮，TUI 新增 `/rewind`。连 AI 的文件改动一起撤销另立议题。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | 撤销的后端、SDK、Web 气泡编辑、TUI `/rewind` | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 消息与 prompt 存储、读取点、忙碌判断、视图缓存、TUI 命令的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 4、接口与迁移、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | kimi-code、codex、ZCode、deepseek-harness、opencode、claude-code 的做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- Stage 2（Web）依赖[消息复制议题](../2026-11-04-message-copy/README.md)的消息操作栏，要在它之后实施。Stage 1（后端）和 Stage 3（TUI）不依赖它。
- 分工在实施前与用户确认。
- 前置：Stage 1 第 8 步要改的 `copy-history.ts` 和 `findEndedMainRun` 由 side chat 和 fork 议题新建，本议题的 Stage 1 要在这两个议题的 Stage 1 之后实施。
- 不可逆点：数据上没有。迁移 `029` 只加可空列，清空 `rewound_at` 就能恢复。但运行中撤销时，停掉的任务、取消的排队、暂停的 goal、停掉的子代理不会恢复，即使撤销最后没做成。

## 相关议题

| 议题 | 关系 |
|---|---|
| [消息复制](../2026-11-04-message-copy/README.md) | 提供消息操作栏 |
| [会话 fork](../2026-11-04-session-fork/README.md) | fork 复制历史和取切点时跳过已撤销的内容；撤销最后落地，由本议题在共用的 `copy-history.ts` 和 `findEndedMainRun` 里补上这个条件 |
| [side chat](../2026-11-04-side-chat/README.md) | side chat 会话里禁用撤销，返回 `SIDE_CHAT_UNSUPPORTED`；撤销最后落地，这个检查由本议题加在撤销入口 |
| 会话存储区（`docs/services/session-storage/`） | 无直接依赖 |
| [已加载 MCP 工具从历史重建](../2026-11-09-mcp-loaded-tools-from-history/README.md) | 先于本议题实施。撤销后调用 `mcpToolMenu.disposeSession(sessionId)`，已加载工具从撤销后的历史重建 |
