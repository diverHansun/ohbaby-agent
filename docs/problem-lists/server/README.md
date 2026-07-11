# server: CLI 默认 in-process 与显式 server 规划

> **历史规划，已被部分取代**：本目录用于解释 ADR-001（默认 TUI in-process、server 显式启动）和早期迁包过程。`ohbaby-server` 包已经存在；v0.1.7 全局单 serve、用户级 pid/state、InstanceStore 与 workspace 路由以 [`../2026-07-11-global-single-daemon/`](../2026-07-11-global-single-daemon/README.md) 和 [`../../ohbaby-server/hono-app/04-multi-project-runtime.md`](../../ohbaby-server/hono-app/04-multi-project-runtime.md) 为准。本文不得再用于判断这些能力“尚未迁包/尚未实现”。

> 2026-06-15 更新：本目录的判断已经从“沿用 daemon 承载 web/app”调整为“默认 CLI 回到 in-process，server 作为显式能力存在”。这不是拍脑袋决定，而是基于 `gemini-cli`、`kimi-code`、`claude-code`、`opencode` 的运行时边界复核后形成的判断。

## 文档导航

| 文档 | 职责 |
|------|------|
| [`01-current-state-and-problems.md`](./01-current-state-and-problems.md) | 记录既有 daemon/server 层的现状问题，作为历史背景和问题索引 |
| [`02-goals.md`](./02-goals.md) | 更新后的目标、非目标、SWE 原则和决策边界 |
| [`03-reference-designs.md`](./03-reference-designs.md) | 早期参考项目调研材料，保留作为背景 |
| [`04-route-a-new-package.md`](./04-route-a-new-package.md) | 路线 A：未来抽 `ohbaby-server` 包的完整方案，适合 web/app/ACP/A2A 真的立项后执行 |
| [`05-route-b-in-place.md`](./05-route-b-in-place.md) | 路线 B：保留 daemon 并就地增强的历史方案，现在降级为 fallback |
| [`06-reference-runtime-findings.md`](./06-reference-runtime-findings.md) | 四个优秀项目的默认 CLI/server/session 做法复核 |
| [`07-route-c-cli-inprocess-explicit-server.md`](./07-route-c-cli-inprocess-explicit-server.md) | 路线 C：短期推荐方案，默认 CLI in-process，server 显式启动 |
| [`08-daemon-module-boundaries.md`](./08-daemon-module-boundaries.md) | 当前 `runtime/daemon/` 模块的保留、迁移、降级、删除边界 |

## 当前判断

四个参考项目给出的共同信号很强：

- 默认交互式 CLI 不依赖隐藏后台 daemon。
- server/remote-control/ACP/A2A/web 都是显式入口、独立模式或一等 server 能力。
- 如果需要进程隔离，也倾向于前台 worker/supervisor，生命周期跟当前 CLI 绑定，而不是跨命令常驻。
- session 持久化不等于多窗口共享同一个可写 runtime；真正的多客户端协作应由显式 server 承担。

因此当前推荐：

1. 短期走路线 C：`ohbaby` 默认使用 in-process runtime，移除默认 hidden daemon auto-spawn。
2. `ohbaby serve` / 未来 `ohbaby-server` 作为显式 server，用于 web/app/attach/多客户端能力。
3. 路线 A 保留为长期目标：当 web/app、ACP/A2A、独立 SDK server helper 形成真实需求时，再抽 `packages/ohbaby-server`。
4. 路线 B 只作为兼容或过渡方案，不再作为主线。

## 状态

- 本目录当前是规划文档更新，尚未进行生产代码重构。
- 既有 `runtime/daemon/` 代码仍需要按 [`08-daemon-module-boundaries.md`](./08-daemon-module-boundaries.md) 做边界审查。
- 后续实施前应先确认 [`07-route-c-cli-inprocess-explicit-server.md`](./07-route-c-cli-inprocess-explicit-server.md) 的分阶段计划。
