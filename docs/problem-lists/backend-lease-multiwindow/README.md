# backend-lease-multiwindow

> 多窗口 in-process 模式下，全局 backend lease 把所有窗口当成一个全局单写者，导致同机只有一个 `ohbaby` 窗口能提交 prompt，其余显示 queued/busy。这是 daemon to in-process 迁移遗留的耦合。本目录记录原因、彻底修复方案、测试与验收标准。

## 背景

v0.1.4 完成了默认 CLI 回 in-process（C1）以及显式 server 迁移（ohbaby-server）。迁移后出现回归：同机打开多个 `ohbaby` 窗口（即使位于不同 project root），只有第一个能运行，其余提交 prompt 时被拒，显示 queued。

这违背了既定的进程模型：默认 CLI 是单窗口单前端的 in-process runtime，不同窗口应是相互独立的 session，能够并发运行。

## 文档导航

| 文档 | 职责 |
|------|------|
| [`01-root-cause-analysis.md`](./01-root-cause-analysis.md) | 原因分析：症状、复现、逐层证据、根因定位、SWE 判断 |
| [`02-implementation-plan.md`](./02-implementation-plan.md) | 实施方案：彻底修复（per-run owner 记录取代全局 lease）、改动清单、迁移、风险 |
| [`03-test-acceptance.md`](./03-test-acceptance.md) | 测试与验收标准：失败回归测试先行、单元/集成/人工验证、验收门 |

## 一句话结论

并发控制应只由 per-session 的 `claimPendingRun` 负责（已正确）；全局 backend lease 是为单 daemon 拓扑设计的不变量，迁移后失效却未被移除。彻底修复 = 移除全局 lease，把崩溃恢复改为 per-run owner（按进程存活判定）的恢复，concurrency 完全交给 per-session claim。

## 修复策略

采用彻底修复（方案 B）：不是简单地在 in-process 路径关闭 lease，而是把"运行所有权 + 崩溃恢复"这一职责从 `ui-persistent` 适配器里的全局 lease，重定位到 `run-ledger`（运行生命周期的真正归属者），用 per-run owner 记录承载并发判定与恢复。
