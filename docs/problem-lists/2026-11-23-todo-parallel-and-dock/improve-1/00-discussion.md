# 讨论记录与已确认要点

> 2026-11-23 与用户讨论，逐项确认后更新。正式方案见 [01](01-problem-analysis-and-current-state.md)、[02](02-optimization-plan-and-change-scope.md)、[03](03-reference-projects.md) 和 [04](04-test-and-acceptance.md)。

## 1. 背景与动机

Todo 列表默认按实施顺序从上往下展示。实际工作中，agent 可能同时推进几个任务，也可能先做靠后的任务，这些任务在列表里不一定相邻。

后端已经允许多个 `in_progress`，也不校验顺序，但提示词没有告诉 agent 列表顺序只是计划顺序。Web 面板目前是偏机械的卡片样式，进行中的状态点是黑色。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|---|---|
| 议题组织 | 前后端放在同一个议题里规划和实施 |
| 并行推进 | 允许多个 todo 同时为 `in_progress`，它们可以不相邻 |
| 实施顺序 | 列表顺序是计划顺序，不是严格队列；前置条件满足的 `pending` 项都可以先开始 |
| 数据结构 | 不变，仍是 `content` + `status`，整表替换 |
| 并行约束 | 只写在提示词里，不用代码校验 |
| 已完成项 | 留在原位并划线，不从列表删除 |
| 列表已满 | 上限仍为 10 条；没有空间放新任务时，移除最早完成的项 |
| 放弃的任务 | 从列表移除，不新增 `cancelled` 状态 |

## 3. 已确认：提示词

`todo_write` 工具描述：

```text
Replace the todo list for the current task with the complete list in planned order. Keep each item in place when its status changes. Maximum 10 items; an empty list clears it.
```

`packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md` 的 “Todo tracking” 中，第 3、4 条替换为：

```text
- Read the current list before revising an existing plan. Preserve still-valid items and their planned order. Keep completed items in place; remove an item only when it is abandoned or superseded, or when the 10-item limit leaves no room for new work (then remove the earliest completed items first).
- List order is the planned order, not a strict queue. Start any pending item whose prerequisites are met.
- Mark an item `in_progress` only while it is actually being worked on. Several items, adjacent or not, may be `in_progress` when subagents, background tasks, or parallel tool calls are really running them at once.
- Update the list at meaningful milestones or when scope changes, not after every command.
```

## 4. 已确认：Web 面板

| 项 | 结论 |
|---|---|
| 面板 | 去掉托盘边框，改为悬浮毛玻璃面板，16px 圆角，和输入框间隔 8px |
| 玻璃参数 | 使用现有的 `--bg-glass` 和 `--glass-blur` |
| 输入区渐变 | 有 todo 时只保留底部的白色渐变，让面板背后的内容能透出来 |
| 进行中 | 11px 淡蓝色 spinner，复用共享 `Spinner` 的转速（0.9 秒一圈）；文字用正文色并稍加粗，不加浅蓝底，也不把文字标成蓝色 |
| 待办 | 浅灰空心环 |
| 已完成 | 深绿细勾，文字划线 |
| 折叠态 | 显示第一个进行中的任务，其余进行中的任务用 `+N` 表示 |
| 展开态 | 自动滚动到第一个进行中的任务 |
| TUI | 只使用新提示词，界面不改 |

## 5. 已确认：边界

| 项 | 本轮处理 |
|---|---|
| todo id、依赖、优先级 | 不做 |
| `cancelled` 状态 | 不做 |
| 校验 `in_progress` 是否真实运行 | 不做，工具看不到运行时状态 |
| 列表上限 | 不调整 |

## 6. 参考项目

本议题参考了 opencode、deepseek-harness（dsh）和 ZCode，详细对照见 [03](03-reference-projects.md)。

## 7. 用户确认记录

- 已完成项：“留在原位划线”。
- 提示词和议题组织：“可以，前后端就放一起规划/实施吧，我就不做分开了”。
- 进行中样式（初版）：“建议方案B即可：静态，整行浅蓝”。
- 进行中样式（2026-11-23 改定，取代初版）：左侧改用淡蓝色转动的 spinner，“速度不慢不快”；有了 spinner，任务文字不再用蓝色标注。
- 关键改动清单：“不用列”。
