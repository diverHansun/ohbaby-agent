# Subagent sandbox scope 设计包

> 创建日期：2026-07-09
> 状态：核心修复已实施；本文保留修复前基线与设计依据

本目录记录 subagent context/instance 化之后暴露出的 sandbox 生命周期问题。下方的旧问题描述是 2026-07-09 的修复前基线，保留它是为了说明为什么不能退回 session-only sandbox。

当前实现：

- `RunManager`、message、context、sandbox 都以 `{ sessionId, contextScopeId? }` 为身份边界；primary 没有物理 `contextScopeId`，仍使用 session scope。
- `RunManager` 负责 acquire/release scoped sandbox lease；单个 run 结束只释放自己的 lease，不销毁 sibling scope。
- `subagent_close` 等待自己的 run lease settle 后销毁对应 scope；session remove/runtime dispose 批量回收所属 contexts。
- `runAgent` 不再设置或销毁 session sandbox；因此同一 child session 下的多个 subagent 可以并发而不互拆资源。

修复前的 session-only key、per-run destroy 和相关竞态分析仍在本目录各文档中，必须按“历史基线”阅读。

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
