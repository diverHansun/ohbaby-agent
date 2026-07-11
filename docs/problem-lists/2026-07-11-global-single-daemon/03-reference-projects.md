# 3. 优秀项目借鉴

> 本议题对齐 **kimi-code / claude-code** 的 TUI 分界，**opencode** 的 serve 多项目，**codex** 仅作对比（不作为默认路径）。

---

## 3.1 总览对照

| 维度 | opencode | kimi-code | claude-code | codex | ohbaby（目标） |
|------|----------|-----------|-------------|-------|----------------|
| 默认 TUI | in-process（`app.fetch` 同进程） | in-process `KimiCore` | in-process REPL | in-process embedded app-server | in-process `UiBackendClient` |
| TUI 连本地 server | 否（同进程 fetch） | **否** | **否** | 可隐式 attach daemon | **否** |
| serve 多项目 | InstanceStore + header | 单 Core + workspace registry | 单 server 内存 | app-server 多连接 | InstanceStore + header |
| 全局单实例发现 | 无统一 lock | `~/.kimi-code/server/lock` | 无（daemon opt-in） | daemon socket | 用户级 `daemon.pid + daemon-state.json` |
| session 持久化 | 共享 SQLite | 文件桶 `sessions/wd_*` | jsonl per project | state_db + rollout | 共享 SQLite |
| 并存写库 | 单进程内多 instance | TUI + server **可并存**，文件分桶 | 多进程 transcript 文件 | TUI 或 daemon | TUI + serve 并存，**claim 防同 session** |
| cron / loop | 无用户 cron 产品面 | session 目录 cron | project `.claude/scheduled_tasks.json` | 非用户 cron | SQLite `scheduler_job` + serve Scheduler |

---

## 3.2 opencode

**参考路径**（上游 `anomalyco/opencode`，本地未 vendoring）

| 能力 | 做法 | ohbaby 映射 |
|------|------|-------------|
| serve 不绑 cwd | `ServeCommand` `instance: false` | `ohbaby serve` 不绑 scopeRoot 才 listen |
| 请求级项目 | `x-opencode-directory` → `InstanceStore.load` | `x-ohbaby-directory` |
| 懒加载 | `Map<directory, Entry>` + deferred boot | `InstanceStore.load(scopeKey)` |
| 回收 | `dispose` / `disposeAll` | 本批仅 `disposeAll`；资源 ownership 闭合后再做 per-scope dispose |
| 持久化 | 共享 SQLite + SyncEvent | 共享 `ohbaby-agent.db` |

**不照搬**

- opencode 默认 `run` 走 injected `app.fetch`；ohbaby ADR-001 保持 TUI 直连 agent。

---

## 3.3 kimi-code

**参考路径**：`/Users/hansun025/Projects/code-cli/kimi-code`

| 能力 | 文件 | 做法 | ohbaby 映射 |
|------|------|------|-------------|
| 默认 TUI in-process | `run-shell.ts` → `createKimiHarness` | 不 import server | 保持 `buildCoreAPIImpl` |
| 全局 server lock | `packages/server/src/lock.ts` | `O_EXCL` + pid 探活 | 借鉴语义；实现沿用现有 `FilePidFile + JsonDaemonStateFile` |
| server 复用 | `daemon.ts` `getLiveLock()` | 第二 `server run` 复用 | 第二 `ohbaby serve` 打印 URL 退出 |
| TUI 不 attach | `kimi-tui.ts` 无 server client | 仅 `/web` handoff | TUI 不 `--remote-port` |
| TUI + server 并存 | 无互斥 | 共享 `~/.kimi-code/sessions/` | 共享 DB + claim |
| session 隔离 | `SessionStore.sessionDirFor(workDir)` | 路径分桶 | `project_root` 列 |
| server ps | `GET /api/v1/connections` | 连接可观测 | `GET /v1/connections` |
| cron | `agent/cron/manager.ts` + `tools/cron/` | session 级 JSON | **不照搬**；我们用 DB + serve Scheduler |

**kimi 教训**

- 无 session 级锁时，同 session 双进程仍有竞态；ohbaby 用 `claimPendingRun` 补强（SQLite 场景更必要）。

---

## 3.4 claude-code

**参考路径**：`/Users/hansun025/Projects/code-cli/claude-code`

| 能力 | 做法 | ohbaby 映射 |
|------|------|-------------|
| 默认 REPL | `cli.tsx` → `launchRepl` → `QueryEngine` in-process | 默认 `ohbaby` |
| 本地 daemon | opt-in `claude daemon start` | `ohbaby serve` 显式 |
| 不连本地 daemon | 无 `queryDaemonStatus` 于默认路径 | TUI 不 attach |
| 并存 | REPL + daemon worker 独立 PID | TUI + serve |
| cron | `.claude/scheduled_tasks.json` + `cronTasksLock.ts` | **单 owner 思想** → serve 进程 Scheduler |
| `/loop` skill | `skills/bundled/loop.ts` → `CronCreate` | 下批 skill → `scheduler_job` API |

**claude 教训**

- 项目级 cron 文件 + lock = 单一 scheduler owner；ohbaby 用 **全局 serve 单进程** 达到同等语义，不必 per-project cron 文件（已选 SQLite）。但 ohbaby job 必须绑定 `scopeKey + sessionId`，单一 owner 不等于全局唯一 job。

---

## 3.5 codex（对比用）

**参考路径**：`/Users/hansun025/Projects/code-cli/codex/codex-rs/`

| 能力 | 做法 | 为何不作为 ohbaby 主路径 |
|------|------|--------------------------|
| 分层 | TUI + embedded / attachable app-server | 引入 embedded vs daemon 分支，复杂度高 |
| 自动 attach | `app_server_target_for_launch` 探测 socket | 与「TUI 永不 attach」冲突 |
| 多客户端 | app-server JSON-RPC 多连接 + thread subscribe | 可借鉴 **connections** 观测，不借鉴 attach |
| 持久化 | state_db + rollout JSONL | 与 ohbaby SQLite 模型不同 |

**可借鉴子集**

- `thread/resume` attach running thread 思想 → 未来 Web 刷新 attach 同 session run 状态（非本批）。
- doctor 检查 daemon 存活 → 可选 `ohbaby serve status` 增强。

---

## 3.6 借鉴结论（统一）

1. **TUI 路径**：跟 kimi / claude，**in-process 到底**。
2. **serve 路径**：跟 opencode 的请求级 workspace context；借 kimi 的 `O_EXCL`/readiness/版本意识，但沿用 ohbaby 双文件 pid/state。
3. **并存**：跟 kimi **允许并存**，但 ohbaby 用 **run_ledger claim** 弥补共享 DB 风险（kimi 靠文件分桶部分缓解）。
4. **loop**：跟 claude **单 scheduler owner**，实现为 serve 内全局 Scheduler + SQLite；每个 job 属于具体 workspace/session，同 job 忙时最多合并一个 pending trigger。
5. **刻意不跟 codex**：不做 TUI 隐式 attach daemon。

---

## 3.7 代码锚点（便于实施时跳转）

| 项目 | 路径 |
|------|------|
| kimi lock | `kimi-code/packages/server/src/lock.ts` |
| kimi daemon 复用 | `kimi-code/apps/kimi-code/src/cli/sub/server/daemon.ts` |
| kimi TUI | `kimi-code/apps/kimi-code/src/cli/run-shell.ts` |
| kimi /web handoff | `kimi-code/apps/kimi-code/src/tui/commands/web.ts` |
| claude loop | `claude-code/src/skills/bundled/loop.ts` |
| claude cron lock | `claude-code/src/utils/cronTasksLock.ts` |
| ohbaby 目标 04 | `docs/ohbaby-server/hono-app/04-multi-project-runtime.md` |
| ohbaby ADR-001 | `docs/ohbaby-server/hono-app/00-scope-and-deltas.md` §3 |
