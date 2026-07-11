# Goal 模式 x Subagent 交叉边界

本目录记录 **goal 长任务编排层** 与 **main/subagent 执行层** 在交叉面上的问题分析、已确认契约、优化方案与验收标准。

**范围说明**

- 不在本议题内：把 master/subagent 多智能体编排收进 `goals` 模块（见 `docs/goals/goals-duty.md` Non-Duty 5）。
- 在本议题内：goal 续跑期间 primary 通过 `subagent_run` 委托子任务时，两层生命周期如何对齐、如何测、如何补契约。
- 前置条件：subagent 调用机制、context scope、sandbox scope 已在 subagent-context 改造中优化（见 `docs/core/agents/2026-07-09-subagent-context/`、`docs/problem-lists/2026-07-09-subagent-sandbox-scope/`）；本议题评估 goal 长任务在此基础上的完成度与鲁棒性。

**讨论来源**

- [00-discussion.md](./00-discussion.md) — 与用户确认的产品契约与边界问答。

**文档索引**

| 文件 | 内容 |
|------|------|
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 问题分析、goals/agents 现状（duty/architecture/data-model/dfd/non-functional/test）、SWE 原则审视 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 已确认契约、优化方案、代码/架构改动面 |
| [03-reference-projects-codex-kimi.md](./03-reference-projects-codex-kimi.md) | codex / kimi-code 借鉴点 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收标准 |

文档审查：由 subagent 只读审查完成（2026-07-10）；结论已并入 01/02/04 修订。

**实施分支**

- 实施分支：`codex/goal-subagent-lifecycle`。按文档、运行时/预算、测试与审查分批提交。
