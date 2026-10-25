# 归档会话管理（恢复与永久删除）

本议题于 2026-10-25 开启。目标是让已归档的会话找得回来：在 Web 设置里新增 Archived 分区，列出已归档的会话，可以恢复到原工作区（原工作区不在了就恢复到无工作区），也可以永久删除。删除只能针对已归档的会话。

顺带修补现有归档的漏洞：运行中的会话被归档后任务不停，永久删除会留下孤儿数据。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-25 | 首轮 | 归档规则修补、列出 / 恢复 / 删除接口、SDK、Web 的 Archived 分区、权威文档同步 | Stage 1 至 4 已实施：后端已验收，Web 与文档同步完成，待用户验收后合并 |

## 前置依赖

本议题在 [工作区命名统一](../2026-10-25-workspace-naming/README.md) 之后实施，字段直接使用新名字：`workspaceDirectory`、`workingDirectory`、`pendingWorkingDirectory`、默认目录（default directory）。如果实施时 workspace-naming 还没有合并，先完成它。

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | D1 至 D10 决定、范围、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 现有归档链路、删除缺口、Web 设置结构 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 接口、规则、分阶段实施、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | deepseek-harness、ZCode、kimi-code、opencode、pi 的归档与删除做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 验收场景和发布门 |
| [05 实施与验收](improve-1/05-implementation-acceptance.md) | 后端接口交接与验收、Web 实现差异、测试与浏览器走查 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 当前分工以 2026-10-25 的实施请求为准：Stage 1、2（后端核心、服务端与 SDK）由 agent 实施并提交；用户验收后实施前端。前端完成后由 agent 做原生浏览器端到端测试，全部通过后再合并和 push。00、02 中的原分工保留为历史记录。
- 不另建模块级 `improve-N/` 文档；受影响的 Web 设计文档在 Stage 4 直接同步。

## 相关文档

- [Web 会话归档（第一版）](../../ohbaby-web/session-archive/README.md)：当时把恢复、归档列表和永久删除留给以后，本议题补上。
- [Web 重设计文档](../../ohbaby-web/redesign-2026-10/README.md)：D12“设置只有 5 个分区”、00 的“不做”清单和 04 的 Undo 说明由本议题修改。
- [无工作区会话与设置后端](../2026-10-20-workspaceless-sessions-and-settings/README.md)：会话归属与目录切换的规则来源。
