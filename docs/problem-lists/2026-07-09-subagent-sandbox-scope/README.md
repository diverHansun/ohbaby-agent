# Subagent sandbox scope 设计包

> 创建日期：2026-07-09
> 状态：实施前设计与验收准备

本目录记录 subagent context/instance 化之后暴露出的 sandbox 生命周期问题。

当前结论：

- `RunManager`、message、context 已经按 `sessionId + contextScopeId` 隔离。
- `SandboxManager` 与 `HostLocalSandboxManager` 仍以 `sessionId` 作为唯一 context key。
- `runAgent` 在 run 结束时还能调用 `setSessionEnvironment(sessionId, undefined)`，从而销毁整个 session sandbox。
- 因此问题不是“缺少 refcount”，而是 sandbox 的身份维度和销毁权限与 run/context/agent instance 不一致。

本轮只先落文档，后续实现按文档拆批推进。

## 文档索引

| 文件 | 作用 |
|---|---|
| [01-current-problem-analysis.md](./01-current-problem-analysis.md) | 现有 sandbox 与 context / agent instance 的错位分析 |
| [02-sandbox-scope-implementation-plan.md](./02-sandbox-scope-implementation-plan.md) | sandbox scope-keyed 实施方案 |
| [03-reference-design-patterns.md](./03-reference-design-patterns.md) | kimi-code 等优秀项目可借鉴的设计模式 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 验收标准与测试矩阵 |
| [05-followup-items-2-to-6.md](./05-followup-items-2-to-6.md) | 第一项 sandbox 之外，2～6 项决策的独立跟进文档 |

## 本轮设计边界

纳入：

- sandbox key 从 session-only 调整到 `sessionId + contextScopeId?`。
- RunManager 接管 sandbox workdir ensure / acquire / release。
- `runAgent` 不再拥有 sandbox 设置与销毁权限。
- 双 subagent 并发下，先完成的 run 不应销毁后完成 run 的 sandbox。

不纳入：

- primary root `AgentInstance` 全面迁移。
- subagent handoff summary-continuation 体验增强。
- container / worktree adapter 新能力。
- 完整资源回收策略的最终形态。本文档只要求不再 per-run 销毁 session 级 sandbox。

