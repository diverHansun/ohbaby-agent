# 会话重命名

本议题于 2026-11-24 开启：用户可以给主会话改名。入口是侧边栏会话的 `…` 菜单和右键菜单里的 Rename，也可以双击标题；标题原地变成输入框，回车保存。后端新增改标题接口，界面只做 Web，不做 TUI。

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 后端 `renameSession` 命令和 `PATCH /v1/sessions/:id/title` | TUI 的 `/rename` |
| 改名不改变会话在列表里的位置 | 顶栏标题点击改名 |
| 侧边栏菜单 Rename、双击标题、行内编辑 | 子代理会话、side chat 改名 |
| | 让 LLM 根据对话重新生成标题 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-24 | 首轮 | 后端接口、侧边栏行内改名 | 已实施，已通过真实 daemon 与内置浏览器验收 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 标题从哪来、怎么防覆盖、改动要经过哪些层 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、分阶段改动、设计文档同步 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | opencode 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 后端、前端和浏览器验收清单 |
