# 讨论记录与已确认要点

> 2026-07-11 与用户多轮讨论定稿。本文件只保留有效结论；原始聊天转录和工具调用已删除，避免早期方案与当前契约混杂。正式实施方案见 01–05。

---

## 1. 背景与动机

1. v0.1.6 Option A 是每个 project-root 一个 foreground serve，多 repo 多端口并存，不利于全局面板与后续 App。
2. 目标收敛为 Option B：**一台机器一个 serve 进程**，单 origin，`InstanceStore` 按请求懒加载多个 workspace runtime。
3. 后续 `/loop` 依赖单一调度 owner 与稳定 serve，但本批不实现 loop 行为、Scheduler、Heartbeat 或数据库 migration。

## 2. 已确认：目标拓扑

| 决策项 | 结论 |
|--------|------|
| 进程模型 | **单进程 + InstanceStore**；不做全局网关 + 每项目 worker 子进程 |
| 持久化 | 共享用户级 SQLite；按 `project_root` / `scopeKey` 过滤；InstanceStore 隔离内存 backend 与 coordination |
| 发现与管理 | 沿用现有 `daemon.pid + daemon-state.json`，迁到 `~/.ohbaby/server/`；不新增单 lock 文件 |
| 路由 | workspace API 必须携带 `x-ohbaby-directory`；`realpath` / `getProjectRoot` 后加载 Instance；缺失或非法路径返回 400，生产环境不回退 query/cwd |
| scope 规则 | canonical git root；非 git 则 canonical directory |
| 默认 CLI / TUI | 永久 in-process，直连 `ohbaby-agent`，不 attach serve |
| Web / App / remote | 只通过全局 serve；任意 cwd 执行 serve 都打开同一 origin，cwd 仅作为初始 selected project 提示 |
| Instance 生命周期 | 本批不做单 workspace 自动回收；serve 停止时统一 `disposeAll()` |
| serve 生命周期 | 显式 foreground serve 不 idle-exit；只由 Ctrl+C、`serve stop`、系统退出或异常停止 |
| 版本策略 | CLI 与存活 server 的 `packageVersion` 必须精确一致；缺版本也视为不兼容；提示显式 stop/start，不自动杀旧进程 |
| legacy 迁移 | 保留一个版本的当前 cwd per-scope daemon 检测及 status/stop fallback；不扫描全盘、不批量 kill |
| `/loop` 真相源 | 未来使用共享 SQLite `scheduler_job`；job 必须绑定 `scopeKey + sessionId`；本批不建表、不实现 Scheduler |

## 3. 已确认：TUI 与 serve 并存（非 attach）

- serve 运行时仍可启动默认 TUI；两者是独立 runtime，共享 SQLite 文件但不共享实时 coordination。
- 不引入全局 backend lease；不同 session 可以并行。
- 同一 session 的并发 run 由 `run_ledger.claimPendingRun` 原子 claim 阻止。
- 不实现跨进程实时 session 同步或共享 prompt queue。
- coexistence 提示属于辅助感知，不能代替 claim；实现时不得让默认 TUI 静态或动态加载 `ohbaby-server`。

## 4. 已确认：双写预防

| 层级 | 机制 | 当前状态 |
|------|------|----------|
| serve 单实例 | 用户级 pid 独占 + state 发现；第二 serve 复用同一 server | 第一纵切已实现 |
| 同 session 并发 run | `claimPendingRun`（`BEGIN IMMEDIATE`）→ `SessionRunBusyError` | 已实现 |
| run 归属与恢复 | `owner_id` / `owner_pid` + `recoverOrphanedRuns` | 已实现；仍需 TUI+serve 集成测试 |
| 全局 backend lease | `persistentUiBackendLease` 已删除 | 勿恢复 |
| TUI 启动感知 | 轻量读取用户级 pid/state + health/version 后提示 | 未实现；不得 import server 包 |
| 跨 runtime UX | busy 错误映射为可理解提示 | 待完善 |
| 未来 `/loop` | Scheduler 只属于 serve；TUI 不注册 durable job | 下批约束 |

## 5. 已确认：与 `/loop` 的关系

- `docs/problem-lists/loop-time/` 是单次 run 的 maxSteps/timeout/retry，不是 `/loop` cron。
- `/loop` 属于 session；全局唯一的只是 Scheduler owner，不是全局唯一 loop。
- 未来触发链：`Global Scheduler → InstanceStore.load(scopeKey) → target session lane → RunManager`。
- Heartbeat 若保留，状态必须按 `scopeKey + sessionId` lane 隔离，不能用机器级状态阻塞全部项目。
- 同一 job 在目标 session busy 时最多合并一个 pending trigger，禁止无限积压。
- 本批不恢复 `scheduler_job` migration/schema，也不添加空 Scheduler/Heartbeat hook。

## 6. 参考项目结论

| 项目 | 可借鉴点 | ohbaby 取舍 |
|------|----------|-------------|
| kimi-code | TUI in-process；全局 server 发现；session 文件分桶 | 借鉴 TUI/server 分界，不照搬单 lock 文件或文件存储 |
| claude-code | REPL in-process；daemon opt-in | 借鉴默认交互路径不依赖 daemon |
| opencode | serve 不绑定 cwd；InstanceStore + 请求级 directory | 借鉴多 workspace 宿主与请求路由 |
| codex | embedded app-server，可 attach daemon | 不采用 attach 作为默认路径，避免网络失败面进入 TUI |

## 7. 本批与后续边界

| 项 | 本批结论 |
|----|----------|
| `scheduler_job` migration | 不恢复；与 `/loop`、SchedulerStore 同 PR 落地 |
| 全局 serve 端口 | 优先 4096；未显式指定且冲突时使用 `port:0`；真实端口只读 `daemon-state.json` |
| per-scope idle dispose | 不做；已加载 runtime 随 serve 统一回收 |
| Web 全局面板 | 已落地 known/loaded 列表、selected 切换与 client/snapshot/SSE 重建 |
| `serve ps` / connections | 已落地 `GET /v1/connections` 与 CLI `serve ps` |
| CORS / 非同源 App | App 立项时再做 |

## 8. 用户确认记录

- 确认 Option B（单进程 InstanceStore），非 gateway+worker。
- 确认共享用户级 DB + per-scope 内存隔离。
- 确认 TUI 永久 in-process，不 attach daemon。
- 确认双写需要机制，不仅是提示。
- 确认沿用 `daemon.pid + daemon-state.json`，不新增单 lock 文件。
- 确认 workspace API fail-closed，无生产 query/cwd fallback。
- 确认任意 cwd 打开同一全局面板，cwd 只影响初始 selected project。
- 确认本批不做单 workspace 自动空闲回收。
- 确认 foreground serve 不 idle-exit。
- 确认 `/loop` 属于 session，job 绑定 `scopeKey + sessionId`，busy 时最多合并一个 pending trigger。
- 确认 `packageVersion` 精确匹配；不一致或缺失都拒绝复用且不自动 kill。
- 确认保留一个版本的 legacy per-scope daemon 兼容检测。

## 9. 为什么本批不恢复 `scheduler_job`

**结论：不恢复。**

| 理由 | 说明 |
|------|------|
| YAGNI | 单 daemon 改造不读写该表；空表没有运行时消费者，只增加迁移和测试负担 |
| 表已删除 | migration `004_drop_scheduler_job` 已 drop；恢复必须使用新 migration |
| 避免契约漂移 | schema 应与 SchedulerStore、`/loop` API 和 session lifecycle 在同一 PR 定稿 |
| 与单 daemon 解耦 | loop 依赖单 Scheduler owner，但不依赖提前建表 |

恢复时机：实现 `runtime/scheduler` 时，同步新增 migration、SchedulerStore 与 session 级字段，至少包含 `scope_key`、`session_id`、`kind`、`next_fire_at`、`status`、`last_fired_at`。
