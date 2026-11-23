# Todo 并行推进与面板优化

本议题于 2026-11-23 开启，解决三件事：让 agent 能按实际情况同时推进多个 todo、灵活选择实施顺序，修复 Goal 停止后任务还显示为进行中的问题，并重做 Web 端的 todo 面板。前后端放在同一个议题里规划和实施。

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 修改 `todo_write` 工具描述和系统提示词，讲清并行、跳序和条目位置规则 | 给 todo 增加 id、依赖、优先级或 `cancelled` 状态 |
| 已完成项留在原位并划线 | 用代码校验 `in_progress` 是否真的在运行 |
| Goal 停止、失败或阻塞后隐藏 todo 面板 | 新 run 开始时自动清理遗留的 `in_progress` |
| Web todo 面板改为悬浮毛玻璃样式，并更新状态图标和折叠摘要 | 调整 10 条的列表上限 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-23 | 首轮 | agent 行为规则、Goal 停止态、Web 面板 | 实施中（分支 `feat/todo-parallel-dock`） |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 当前实现、问题和文档差距 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策、分阶段改动、风险和回滚 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | opencode、dsh、ZCode、Codex 的取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 用例、回归清单和验收标准 |
| 05 实施验收 | 本轮实施完成后，由验收模式写入 `05-implementation-acceptance.md` |

## 实施约定

02 和 04 是交给实施会话的契约：开发者按 02 改代码，按 04 自测。规划会话本身不写代码。
