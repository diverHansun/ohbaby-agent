# 前端契约统一与命令记录

> 状态：两轮规划已完成一致性检查与独立审查，待用户确认后进入实施会话
> 日期：2026-08-13
> 目标：用一份 SDK 权威合同服务 TUI、CLI、Web 与远程 daemon，同时建立不重复、可脱敏的写操作记录。

本议题按依赖方向分为两轮，而不是把每个问题拆成一个 `improve-N`：

1. [`improve-1/`](./improve-1/)：先固定底层数据语义、Prompt 生命周期、读写能力、关联 ID 和命令记录合同。
2. [`improve-2/`](./improve-2/)：再让 CLI/TUI/Web/Server 采用该合同，统一 Web 事件数据流，删除旧契约和兼容分支。

`improve-N` 表示一轮完整优化；每轮内部包含多个相互关联的问题和实施阶段。实施顺序必须是 improve-1 通过测试与验收后，才进入 improve-2。

## 文档地图

| 轮次 | README | 讨论 | 现状与问题 | 优化方案 | 参考项目 | 测试与验收 |
|------|--------|------|------------|----------|----------|------------|
| improve-1 | [README](./improve-1/README.md) | [00](./improve-1/00-discussion.md) | [01](./improve-1/01-problem-analysis-and-current-state.md) | [02](./improve-1/02-optimization-plan-and-change-scope.md) | [03](./improve-1/03-reference-projects.md) | [04](./improve-1/04-test-and-acceptance.md) |
| improve-2 | [README](./improve-2/README.md) | [00](./improve-2/00-discussion.md) | [01](./improve-2/01-problem-analysis-and-current-state.md) | [02](./improve-2/02-optimization-plan-and-change-scope.md) | [03](./improve-2/03-reference-projects.md) | [04](./improve-2/04-test-and-acceptance.md) |

原始讨论材料保留在 [`improve-1/raw.md`](./improve-1/raw.md)。其中包含早期假设和已被代码调研推翻的方案；实施不得直接以 `raw.md` 为契约。

每轮实施完成后另开验收会话，分别产出 `improve-1/05-implementation-acceptance.md` 与 `improve-2/05-implementation-acceptance.md`。本规划会话不修改应用代码。
