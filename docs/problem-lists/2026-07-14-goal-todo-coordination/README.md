# Goal × Todo 协作优化

本目录记录 Goal 模式与 Todo 工具协作的现状、设计决策、参考项目证据、改动面和验收标准。方案已完成对齐并进入实现与验收阶段。

## 背景

OhBaby 已分别具备：

- 可跨 continuation 自动推进的 Goal；
- 面向多步骤任务的 Todo 列表；
- Web/CLI 对 Todo 的实时展示。

但两套能力目前只在同一个 session 内并列存在，没有显式的 workload ownership。Goal 暂停后执行普通任务、再恢复 Goal 时，Todo 可能被读取或覆盖；同时 Todo 面板跟随单次 run 显隐，会在 continuation 边界闪烁。

## 已确认契约

1. Goal Todo 使用内部作用域 `goal:<goalId>`，不向模型或用户暴露 scope 参数。
2. Goal active 期间，Todo 面板跨 continuation 持续可见。
3. Goal complete 前要求模型 reconcile Todo，但不设置运行时硬门禁。
4. Goal objective 是完成判定的唯一权威；Todo 是可选的执行里程碑视图。
5. Todo 只在多步骤、依赖明显或需要持续展示进度时使用，不因进入 Goal 模式而强制创建。

## 本轮范围

- 定义 ordinary、Goal-owned primary run、subagent 三类 Todo scope 的解析规则；
- 定义 scope 在 run 生命周期内的冻结与释放；
- 定义 active、pause、resume、complete、cancel、replace 下的 Todo 数据与 UI 行为；
- 补齐 prompt、恢复逻辑、测试矩阵与权威文档改动面；
- 参考 Codex、Kimi Code、Claude Code 仓库的实现取舍。

## 非目标

- 不把 Todo 写入 Goal 聚合或作为 `UpdateGoal(complete)` 的前置条件；
- 不给 TodoItem 增加 `goalId`，也不在公开 SDK/UI 事件中暴露内部 scope；
- 不引入新的 Todo 数据库表；
- 不改变 subagent 的 Todo ownership；
- 不在本轮实现 persistent Goal 重启完整链路之外的新持久化产品能力。

## 文档索引

- [00-discussion.md](./00-discussion.md)：已确认决策与待对齐问题
- [01-current-and-problem-analysis.md](./01-current-and-problem-analysis.md)：现状、根因与风险
- [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md)：目标架构、行为契约与改动面
- [03-reference-projects.md](./03-reference-projects.md)：Codex、Kimi Code、Claude Code 借鉴
- [04-test-and-acceptance.md](./04-test-and-acceptance.md)：测试矩阵与验收标准

## 基线与状态

- OhBaby 基线：`dbf3360b546d17d2dff404965429ecb24b08e394`
- 文档日期：2026-07-14
- 状态：实现与确定性回归已完成；scope、lease、replace、legacy recovery 与测试门槛均已落地
- 已定产品决策：`/goal replace` 保持 goalId 并沿用 scope；`CreateGoal({replace:true})` 创建新 identity，旧 run lease 冻结到 settlement；旧无 scope Todo 只按 ordinary 处理，不做猜测迁移；真实模型重复评测属于非阻塞质量证据。
