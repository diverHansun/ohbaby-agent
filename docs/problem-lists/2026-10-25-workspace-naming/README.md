# 工作区命名统一（project → workspace）

本议题于 2026-10-25 开启。目标是把“用户选的文件夹”从 project 改叫 workspace，并把会话里几个含义不清的目录字段改成名副其实的名字；Web 侧栏同时把“No project”分组改成底部的 Recents 列表。

这是一次命名和语义整理，不改变会话归属、目录切换、全局列表、搜索等已有行为。这些行为仍以 [无工作区会话与设置后端 improve-1](../2026-10-20-workspaceless-sessions-and-settings/improve-1/00-discussion.md) 的确认结论为准。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-25 | 首轮 | 数据库列、核心会话类型、服务端与 SDK 契约、Web 命名与 Recents、权威文档同步 | 已实施并验收，见 [05](improve-1/05-implementation-acceptance.md) |

归档会话管理（Settings 里的 Archived 页面、恢复、永久删除）是另一个议题，放在 `../2026-10-25-archived-sessions/`，在本议题实施完成后再规划。它依赖本议题定下的新名字。

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 术语表、范围、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 命名混用的证据和影响面 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 分阶段实施、迁移、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | opencode、Codex、deepseek-harness、kimi-code、ZCode、pi 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 验收场景和发布门 |
| [05 实施验收](improve-1/05-implementation-acceptance.md) | 后端与前端的实际改动、差异、测试与走查 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 分工：Stage 1、Stage 2（后端、SDK、契约层）由用户实施；Stage 3（Web 界面）和 Stage 4（文档同步）由 agent 在后端完成后实施。
- 本议题不另建模块级 `improve-N/` 文档：改的是名字，不改模块职责和结构。受影响的权威设计文档在 Stage 4 直接同步。

## 相关文档

- [无工作区会话与设置后端](../2026-10-20-workspaceless-sessions-and-settings/README.md)：会话归属、目录切换和默认目录的行为来源。本议题只改名字，该议题 improve-1/02 中的 `POST /v1/sessions/:sessionId/project` 与 `projectDirectory` 契约由本议题 02 取代。
- [Web 重设计文档](../../ohbaby-web/redesign-2026-10/README.md)：Stage 4 需要同步的前端设计文档。
- [project 模块](../../project/goals-duty.md)：Git 仓库身份识别。本议题之后，project 一词只指它。
