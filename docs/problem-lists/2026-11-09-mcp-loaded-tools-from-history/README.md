# 已加载的 MCP 工具从历史重建

本议题于 2026-11-09 开启。模型用 `select_tools` 加载过哪些 MCP 工具，现在只记在内存里（`McpToolMenu.loadedByScope` 和 `ScopeToolSequence`）。daemon 重启、会话恢复、MCP 刷新失败之后，这份记录就丢了，模型再调用之前加载过的工具会被 `accessGuard` 拒绝。本议题把“已加载工具”改成从历史里 `select_tools` 的结果推导出来，内存里只留缓存。

议题来自 [session fork](../2026-11-04-session-fork/README.md) 的讨论：side chat 和 fork 原计划用 `copyScope(from, to)` 在创建会话时复制内存状态，那只是绕过问题。本议题先于它们实施，这两处 `copyScope` 不用再写。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-09 | 首轮 | 从历史重建已加载工具（含压缩、各上下文作用域）；工具顺序按规则计算、删除 `ScopeToolSequence`；去掉会话累计上限；side chat、fork 不再需要 `copyScope` | 已实施（分支 `fix/mcp-loaded-tools-from-history`），待验收 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 两份内存状态、历史里已有的数据、压缩与缓存、工具顺序、累计上限、测试现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 3、接口、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | codex、kimi-code、ZCode、dsh、pi、claude-code 的做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门、对抗性审查 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- **开发顺序**（2026-11-10 用户确认）：本议题先于 side chat、fork、撤销重发实施，三者都依赖它。
- 不可逆点：无。不改数据库结构。

## 相关议题

| 议题 | 关系 |
|---|---|
| [side chat](../2026-11-04-side-chat/README.md) | 依赖本议题：打开 side chat 后从复制来的历史重建已加载工具，原计划的 `copyScope` 不再写 |
| [会话 fork](../2026-11-04-session-fork/README.md) | 同上；新会话得到切点那一刻的已加载工具 |
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 撤销后调用 `mcpToolMenu.disposeSession`，让已加载工具从撤销后的历史重建 |
