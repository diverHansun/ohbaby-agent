# terminal-daemon：终端多窗口会话与 Daemon 架构

> 解决 `pnpm start` 多终端窗口下的会话冲突问题，并推进 daemon 架构上线。
>
> **历史定位（2026-07-12）**：本目录保留早期问题证据与 run claim/FIFO 意图。其 auto-spawn、默认 TUI attach daemon、内存 daemon 全局 FIFO 和空闲自退终态已被 [`../2026-07-11-global-single-daemon/`](../2026-07-11-global-single-daemon/README.md) 取代；当前默认 TUI 永久 in-process。多 session 真并发、同 session FIFO、durable waiting queue 与即时 receipt 的新权威契约见 [`../2026-07-12-workspace-prompt-concurrency/`](../2026-07-12-workspace-prompt-concurrency/README.md)。若正文冲突，以两个新目录为准。

## 文档导航

| 文档 | 职责 | 适合谁 |
|------|------|--------|
| [`01-problem-analysis.md`](./01-problem-analysis.md) | 逐一定位问题，精确到代码行号 | 开发者了解现状 |
| [`02-solution-design.md`](./02-solution-design.md) | 三阶段实施方案与代码变更清单 | 开发者编码实施 |
| [`03-reference-projects.md`](./03-reference-projects.md) | opencode/gemini-cli/kimi-code/claude-code 的设计分析 | 架构师/开发者参考 |
| [`04-test-criteria.md`](./04-test-criteria.md) | 分阶段测试策略与验收标准 | QA/开发者自检 |
| [`05-implementation-plan.md`](./05-implementation-plan.md) | Phase 1-4 实施计划（Phase 1 详尽，3/4 为总体规划） | 实施者按 task 执行 |

## 问题摘要

| # | 问题 | 严重性 | 修复 Phase |
|---|------|--------|-----------|
| P1 | `activeSessionId` 存储于 DB 导致多终端同会话 | 🔴 架构 | Phase 1 |
| P2 | `promptInFlight` 仅进程内存，跨进程不可见 | 🔴 架构 | Phase 1 |
| P3 | 终端启动行为隐式（取决于 DB 中的旧值） | 🟡 设计 | Phase 1 |
| P4 | 空 session 查找逻辑分散在 3 处 | 🟡 设计 | Phase 2 |
| P5 | `ui-inprocess.ts` 单文件 1696 行 | 🟡 设计 | Phase 2 |
| P6 | Daemon 模块已实现但未接入生产路径 | 🔴 架构 | Phase 3 |
| P7 | 跨进程无 session 忙标志 | 🔴 架构 | Phase 1 |
| P8 | `serve` 命令为 stub | 🟡 设计 | Phase 3 |
| P9 | `snapshotStatus` 全局扫描导致运行状态跨进程串扰 | 🟡 设计 | Phase 1 |
| P10 | run 创建失败时残留 ghost user message | 🟡 设计 | Phase 1 |
| P11 | 顺序 run ID 跨进程碰撞 | 🟡 设计 | Phase 1 |

## 实施路线

```
Phase 1 (2-3 天)          Phase 2 (3-5 天)          Phase 3 (2-3 周 + 3b)
  ┌──────────────┐       ┌──────────────┐       ┌─────────────────────┐
  │ 终端窗口解耦  │  ──►  │ 内部重构净化  │  ──►  │ Daemon 上线          │
  │ P1 P2 P3     │       │ P4 P5        │       │ 3a 显式 serve（架构） │
  │ P7 P9        │       │              │       │ 3b auto-spawn（产品）│
  │              │       │              │       │ P6 P8               │
  └──────────────┘       └──────────────┘       └─────────────────────┘
```

关键设计决策（讨论定稿）：

- 启动默认 = **空白新视窗**：`activeSessionId = null`，首条 prompt 才创建 session（零空会话堆积）
- 显式入口：默认新视窗 / `--resume <id>` / `--continue`（最近 primary session）
- 并发控制：Phase 1 用 run_ledger **原子占位**（`BEGIN IMMEDIATE` compare-and-claim）；Phase 3/4 daemon 单写者 + 内存 RunState，run_ledger 降级为审计/恢复
- 入口语义 = **排队**（2026-06-12 修订）：同终端同 session prompt 走本地 FIFO（Phase 1），double-Esc 中断后自动续跑；跨终端严格 FIFO 由 daemon 全局队列保证（Phase 4）；claim 层的 busy 错误由队列消费，不直接报给用户
- 发布终态：daemon 由 `ohbaby` **按需自动拉起**（版本握手 + 空闲自退 + `--no-daemon` 逃生舱）
- ACP/A2A **暂缓**：投资 `UiBackendClient` 契约这条"缝"，协议适配层按需后加

## 相关模块

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` — 当前核心问题文件
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` — activeSessionId 持久化
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts` — 会话恢复入口
- `packages/ohbaby-agent/src/runtime/daemon/` — 已有 daemon 模块
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` — CLI 入口
- `packages/ohbaby-cli/src/cli/commands/serve.ts` — serve 命令（stub）
