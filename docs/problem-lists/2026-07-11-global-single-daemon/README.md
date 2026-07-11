# 全局单 Daemon（Option B）改造

本目录记录 **多 daemon / 多端口 serve** 收敛为 **单进程全局 serve + InstanceStore 多项目** 的问题分析、已确认设计、改动面、参考项目借鉴、测试验收与文档审查。

**范围说明**

- **在本议题内**：`ohbaby serve` 全局单实例；沿用现有 `daemon.pid + daemon-state.json` 并迁移到用户级目录；`InstanceStore` + `x-ohbaby-directory` 请求级路由；全局 Web 面板的项目发现/默认选中语义；Web/App/`--remote-port` 适配；TUI **永久 in-process**（不 attach serve）；TUI 与 serve 并存时的 **双写预防**（机制 + 提示）；一个版本的 legacy per-scope daemon 兼容检测。
- **不在本议题内**：`/loop` / `scheduler` / `heartbeat` 行为实现（仅确认未来由全局 Scheduler 按 `scopeKey + sessionId` 路由）；单 workspace 自动空闲回收；LAN/mDNS/TLS；detached 后台常驻主路径。
- **与历史文档关系**：`docs/ohbaby-server/hono-app/04-multi-project-runtime.md` 为目标态权威；`08-v0.1.6-scoped-serve-ports.md` 为已落地的过渡态；`docs/problem-lists/terminal-daemon/` 偏早期多终端解耦，单 daemon 以本文为准。

**讨论来源**

- [00-discussion.md](./00-discussion.md) — 与用户确认的产品与架构决策。

**文档索引**

| 文件 | 内容 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 讨论记录与已确认要点 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 问题分析、代码现状（duty/architecture/data-model/dfd/non-functional/test）、SWE 原则审视 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 优化方案、双写预防、代码/架构改动面 |
| [03-reference-projects.md](./03-reference-projects.md) | opencode / kimi-code / claude-code / codex 借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收标准 |
| [05-document-review.md](./05-document-review.md) | 文档自审与方案对抗性检查 |

**实施说明**

- 实施前以本文 00–05 为契约；`/loop` 表结构与 migration 在 **loop 批次**与 Scheduler 同 PR 落地，不阻塞本批 serve 单实例。
- 默认 `ohbaby` TUI 路径 **不修改**（ADR-001 延续）。
- 显式前台 `ohbaby serve` **不因无客户端而自动退出**；仅由 Ctrl+C、`serve stop`、系统退出或异常停止。
- CLI 与存活 server 的 `packageVersion` 必须精确一致；不一致时拒绝复用并提示显式重启，禁止自动杀死旧 server。

**2026-07-11 实施进度**

Phase 1 已完成：用户级 pid/state、跨 repo 复用、启动 readiness 等待、精确版本门禁、一个版本的当前 cwd legacy 检测、foreground 不 idle-exit、Promise 去重 InstanceStore、workspace API fail-closed 路由、per-scope backend/coordination/SSE 隔离，以及 CLI/Web 的显式 directory 透传均已落地。第二次从其他 repo 执行 `serve` 时，通过 URL fragment 给全局面板传递初始 selected project；fragment 只由前端转换为显式 header，不是 server query/cwd fallback。

Phase 1b 发布门也已关闭：全局面板可展示 known/loaded workspace 并切换 selected scope，切换会重建 client/snapshot/SSE；`GET /v1/connections` 与 `ohbaby serve ps` 已提供连接观测；默认 TUI 通过轻量 pid/state + health/version 检查给出 coexistence 提示且不加载 `ohbaby-server`；真实双进程测试证明第二次 `serve` 复用同一 listener；跨进程双写测试证明同 session 仍由 run claim 保证至多一个 active run。自动化与真实浏览器验收记录见 [04-test-and-acceptance.md](./04-test-and-acceptance.md)。
