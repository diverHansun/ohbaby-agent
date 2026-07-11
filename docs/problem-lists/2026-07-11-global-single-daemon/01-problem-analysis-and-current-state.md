# 1. 问题基线与当前实施状态

> 时间口径：§1.1 的“当前”指本议题启动时的 v0.1.6 基线；§1.3–§1.8 已按 2026-07-11 第一纵切代码更新。不要把基线问题误读为仍未实现。

## 1.1 问题陈述

本议题启动时，`ohbaby serve` 实现的是 **v0.1.6 Option A**（一 serve 一 scope、多 scope 多端口），导致：

1. 每个 project-root 启动一个 foreground 进程，Web 需多个浏览器窗口/端口，无法形成统一面板。
2. 后续 App 端需要稳定 `baseUrl`（单端口），多 daemon 直接阻碍集成。
3. 未来 `/loop` 需要 **进程级单一 Scheduler owner**；多 serve 进程会导致重复 fire 与 SQLite 多写者冲突。
4. `docs/ohbaby-server/hono-app/04-multi-project-runtime.md` 描述的 **InstanceStore + 用户级全局发现 + 请求级路由** 当时尚未实现；第一纵切现已落地这些基础能力。

核心矛盾：**project 仍是进程维度**（N 个 cwd → N 个 serve），而目标态要求 **project 是请求维度**（1 个 serve → N 个 scope backend）。

---

## 1.2 已确认的产品分界（讨论结论）

```
默认 ohbaby / TUI  →  in-process（ohbaby-agent），永不 remote attach
ohbaby serve       →  Web / App / --remote-port 的唯一宿主（全局单实例）
并存               →  允许，但两套 runtime；同 session 靠 run_ledger 防双写
/loop（后续）      →  session 级 job（scopeKey + sessionId）；全局 Scheduler 仅 serve 进程
```

这与 **kimi-code**（TUI in-process，Web 用 server）、**claude-code**（REPL in-process，daemon opt-in）一致；与 **codex**（TUI 可 attach daemon）刻意区分。

---

## 1.3 ohbaby-server 现状（按 plan-module-design 结构）

### 1.3.1 goals-duty

来源：`docs/ohbaby-server/goals-duty.md`、`docs/ohbaby-server/hono-app/04-multi-project-runtime.md`

**Design Goals（与本议题相关）**

- **G3 协议中性**：同一 backend 服务 jsonrpc（CLI remote）与 REST+SSE（web）。
- **G4 显式生命周期**：`ohbaby serve` 显式启动/停止。
- **G5 runtime 唯一性**：多项目宿主下细化为 **serve 内每 workspace scope 一个 backend**（InstanceStore 隔离），非聚合网关。全机仍允许 TUI 与 serve 两个 SQLite 写进程，因此不再将其表述为“全机单写者”。

**Duties**

- D1–D4：HTTP/SSE、协议适配、多客户端协调（prompt-queue、permission-router、event-bus replay）、auth/CORS。
- D6：foreground `ohbaby serve` 主路径。

**Non-Duties**

- **N1**：不承载领域逻辑（session、tool、持久化在 agent）。
- **N2**：默认 CLI **不**经过 server（ADR-001）。
- **N6**：supervisor/pid/state 沿用现有能力，但其路径从 per-scope 迁到用户级；显式 foreground 主路径仍使用 `daemon.pid + daemon-state.json`，不新增单文件 lock。

**当前实现说明**

- `runtime/daemon/server.ts` 在全局 Hono router 层持有 `InstanceStore`，每个 scope 创建独立的 `createDaemonServerApp()` runtime。
- `create-app.ts` 自身仍保持“单 backend + 单套 coordination”的高内聚边界；多 scope 组合由 server 层完成。因此 backend、client view、prompt queue、permission router、EventBus 与 SSE replay 已按 scope 隔离，无需把 InstanceStore 直接塞进 create-app。

### 1.3.2 architecture

**v0.1.6 基线拓扑**

```
ohbaby serve (per scopeRoot)
  → resolveDaemonScope(cwd) → <scopeRoot>/.ohbaby/server/{daemon-state.json, daemon.pid}
  → createPersistentUiBackendClient({ workdir: scopeRoot })
  → createDaemonHttpServer → create-app.ts（单 backend）
  → listen 127.0.0.1:4096 或 port:0 避让
```

**当前拓扑（第一纵切）**

```
ohbaby serve（全局唯一）
  → acquire ~/.ohbaby/server/daemon.pid
  → listen 成功后写 ~/.ohbaby/server/daemon-state.json
  → createDaemonHttpServer({ createWorkspaceBackend, scopeRoot })
  → global router: 必需 x-ohbaby-directory → InstanceStore.load(scopeKey)
  → per-scope createDaemonServerApp: backend + prompt-queue + permission-router + client-view + event-bus
  → 单 SQLite 连接（进程级）
```

**关键文件（现状）**

| 路径 | 职责 |
|------|------|
| `packages/ohbaby-server/src/runtime/daemon/main.ts` | 组合根：scope、复用、端口、start/stop |
| `packages/ohbaby-server/src/runtime/daemon/scope.ts` | 用户级 registry 路径 + 当前 cwd legacy 路径 |
| `packages/ohbaby-server/src/runtime/daemon/server.ts` | 全局 router、InstanceStore、per-scope app runtime 组合 |
| `packages/ohbaby-server/src/app/create-app.ts` | 单 workspace app runtime；单 backend 与单套 coordination |
| `packages/ohbaby-server/src/coordination/*.ts` | prompt-queue、permission-router、event-bus |
| `packages/ohbaby-server/src/protocols/jsonrpc/client.ts` | remote UiBackendClient（CLI `--remote-port`） |
| `packages/ohbaby-cli/src/bin.ts` | 默认 in-process；remote 走 server client |

**本批新增模块**

- `packages/ohbaby-server/src/runtime/instance-store.ts`
- `packages/ohbaby-server/src/runtime/workspace-scope.ts`
- 不新增 `instance/lock.ts`；沿用 `runtime/daemon/pid-file.ts` + `state-file.ts`。

### 1.3.3 data-model

**共享 SQLite**（`packages/ohbaby-agent/src/services/database/`）

- 默认路径：`~/Library/Application Support/ohbaby-agent/ohbaby-agent.db`（macOS）等，见 `path.ts`。
- **session**：`project_id`、`project_root`；`listByProjectRoot()` + `sameSessionProjectRoot()` 过滤。
- **run_ledger**：`run_id`、`session_id`、`status`、`owner_id`、`owner_pid`（跨进程归属与孤儿恢复）。
- **scheduler_job**：migration `004` 已 drop；本批明确不恢复，未来与 SchedulerStore 同 PR 落地。
- **app_state**：`persistentUiBackendLease` 已在迁移中删除，勿恢复。

**InstanceStore 概念（已落地）**

```typescript
// server.ts 的实际组合边界
interface WorkspaceAppInstance {
  appHandle: DaemonServerAppHandle; // 内含该 scope 的 backend + coordination
  dispose(): Promise<void>;
}
```

**ServerRegistry / 用户级双文件**

```json
// ~/.ohbaby/server/daemon.pid（独占互斥）
{ "pid", "startedAt", "token" }

// ~/.ohbaby/server/daemon-state.json（监听成功后的发现真相）
{ "status", "pid", "pidToken", "host", "port", "authToken", "packageVersion", "startedAt", "updatedAt" }
```

旧 per-scope pid/state 只用于一个版本的兼容检测，不再记录某 scope 是否 load。是否已加载属于 InstanceStore 内存状态，不创建第二份磁盘真相。

### 1.3.4 dfd / workflow

**路径 A：默认 TUI（不变）**

```
用户 → ohbaby-cli/bin.ts → buildCoreAPIImpl → createPersistentUiBackendClient
     → getDatabase()（进程内单连接）→ submitPrompt → claimPendingRun → lifecycle
```

**路径 B：Web / remote（第一纵切已落地）**

```
Web/App/CLI --remote-port
  → HTTP(S) → auth → global workspace router/dispatcher
  → InstanceStore.load(scopeKey) → backend.submitPrompt
  → 同路径 claimPendingRun（同一 DB）
```

workspace header 缺失、路径不存在或不可读时返回结构化 400；生产环境不得退回 query parameter 或 serve 进程 cwd。健康检查、shutdown、文档与静态资源属于全局路由，不要求 workspace header。

**路径 B2：全局面板项目选择**

```
任意 cwd 执行 ohbaby serve
  → 复用同一个全局 URL / Web 应用
  → 当前 canonical scope 只作为初始选中项目提示
  → 面板从 DB project_root + 已加载 scopes 展示 known projects
  → 切换项目仅改变 x-ohbaby-directory，不换端口
```

**路径 C：TUI + serve 并存（目标行为）**

```
进程 T（TUI）                    进程 S（serve）
  in-process backend               InstanceStore[scopeA|scopeB...]
       \                              /
        \─── ohbaby-agent.db ───────/
              claimPendingRun(sessionX) 串行化同 session 写
```

**同 session 双写时序（预防）**

1. TUI 对 session S 提交 → `claimPendingRun` 成功，`owner_pid=T`。
2. Web 对 session S 提交 → `claimPendingRun` 失败 → `SessionRunBusyError` 或本端 FIFO 排队（Web 侧队列语义见 coordination）。
3. TUI 进程崩溃 → `recoverOrphanedRuns` 在 **下次任一端启动 backend 时** 将 stale run 标 `interrupted`（若 pid 不存活）。

### 1.3.5 non-functional

| 属性 | 现状 | 目标 |
|------|------|------|
| 可管理性 | 用户级 status/stop、单 origin、`serve ps` / connections 已落地 | 后续可增加更丰富的资源指标 |
| runtime 唯一性 | 全机一个 serve；serve 内每 scope 一个 app runtime | TUI+serve 仍靠 per-session claim |
| TUI 延迟 | in-process，无序列化税 | 保持 |
| 安全 | loopback token 注入 web | fail-closed auth；App 立项再加 CORS |
| 生命周期 | foreground 不 idle-exit 已落地 | detached 生命周期另议；无需 scheduler 空钩子 |
| 版本兼容 | `packageVersion` 精确匹配已落地 | 不一致/缺失提示显式重启，不自动 kill |
| workspace 回收 | `disposeAll()` 已落地 | 本批不做 per-scope 自动回收 |
| 可观测性 | `GET /v1/connections` 与 `ohbaby serve ps` 已落地 | 后续扩展订阅与资源指标 |

### 1.3.6 test（现状覆盖）

| 区域 | 已有 | 缺口 |
|------|------|------|
| 用户级 pid/state 与跨 repo 复用 | `main.unit.test.ts` | 已覆盖 readiness、版本、legacy、端口避让 |
| claimPendingRun 跨进程 | `run-ledger` 单测、contract 测试 | TUI+serve 同 session 集成 |
| remote client HTTP/SSE header | `protocols/jsonrpc/client.unit.test.ts`、Web client tests | 已覆盖 directory 透传；面板切换重绑仍待测 |
| InstanceStore / fail-closed scope | `runtime/instance-store.unit.test.ts`、`runtime/daemon/global-server.integration.test.ts` | 已覆盖并发去重、失败重试、非法 scope 400、per-scope app |
| 用户级 pid stale / readiness | `pid-file.unit.test.ts`、`main.unit.test.ts` | 已覆盖；仍缺真实双进程发布门测试 |

---

## 1.4 ohbaby-agent / ohbaby-sdk / ohbaby-web 现状

### ohbaby-agent

- `createPersistentUiBackendClient`（`ui-persistent.ts`）每次创建 **完整 backend 栈**，含 `createDatabaseRunLedger({ ownerId, ownerPid: process.pid })`。
- `activeSessionId` 已 **进程内存化**（terminal-daemon Phase 1），不持久化到 `app_state`。
- 全局 `persistentUiBackendLease` **已移除**（`backend-lease-multiwindow` 结论正确）。

### ohbaby-sdk

- 仅 `UiBackendClient` 契约，**无网络、无 scope**。
- remote 实现在 `ohbaby-server`，不在 sdk 包内。

### ohbaby-web

- `bootstrap.ts` 读取 server 注入的初始 scope，并允许 URL fragment 覆盖 selected directory；fragment 只在前端转为 header，不是 server fallback。
- `api/daemon/http.ts` 与 `events.ts` 已注入显式 `x-ohbaby-directory`。
- 全局面板的完整多项目交互仍可后续增强；本批至少需要 known-project 列表、初始选中 scope 和切换时注入 header 的最小闭环，不能再保留“单项目默认 directory”假设。

---

## 1.5 SWE 原则审视（learn-swe-before-implement）

### 1.5.1 有直接指导意义的原则

| 原则 | 来源 | 本项目场景 | 优先级 |
|------|------|------------|--------|
| 管理复杂度 | 00-philosophy | 从「N 进程 N 端口」收敛到「1 serve + InstanceStore」，消灭偶然复杂度 | 高 |
| 稳定依赖 / 唯一性边界 | 02-fundamental-forces | 单 serve 消灭多端口；TUI+serve 是合法多写进程，同 session 靠原子 claim | 高 |
| YAGNI | 03-design-principles | 不做 gateway+worker、不做 TUI attach、不做 loop Scheduler 本批 | 高 |
| 信息隐藏 | 02 | scope 解析只在 `runtime/workspace-scope`；客户端只传 directory | 中 |
| ADR 可逆性 | swe-architecture | InstanceStore 可渐进：先 lock+store，再改 create-app | 中 |

### 1.5.2 反例与项目曾犯错误

| 反例 | 项目位置 | 说明 |
|------|----------|------|
| 全局 backend lease | 已删除 | 把「单写者」错放在全局闸门，阻塞不同 session 并发（`backend-lease-multiwindow`） |
| per-cwd daemon state | v0.1.6 历史基线 | 导致 N 个不可管理后台；新主路径已迁到用户级 registry |
| 文档与代码漂移 | `problem-lists/server` 称未迁包 | 实际 `ohbaby-server` 已存在，需以 hono-app/04 为准 |

### 1.5.3 有意识的合理权衡

| 权衡 | 理由 | 长期代价 |
|------|------|----------|
| TUI 不 attach serve | kimi/claude 验证的低延迟主路径；ADR-001 | TUI 与 Web 无实时协同，靠 claim 防双写 |
| 共享 DB 而非 per-scope 文件 | 已投入 SQLite schema；跨项目历史查询 | 多进程写库需严格 claim + 单 serve |
| per-scope EventBus | 隔离 replay 与 seq，略增内存 | 本批不自动回收，内存随访问 scope 增长；在长期后台模式上线前补回收 |

---

## 1.6 风险地图

| 问题 | 严重性 | 可优化性 | 位置 | 建议 |
|------|--------|----------|------|------|
| 多 serve 同写 DB | 架构 | 已验证 | `main.ts` 用户级 pid/state | 真实双进程测试证明第二次 serve 复用同一 listener |
| InstanceStore 资源增长 | 架构 | 暂缓 | `runtime/instance-store.ts` | 本批仅 disposeAll；长期后台前设计 per-scope 回收 |
| TUI+Web 同 session 双写 | 设计 | 已验证 | `run-ledger` + UI 提示 | 跨进程集成测试验证 claim 只允许一个 active run |
| Web 全局切换器 | 设计 | 已落地 | `ohbaby-web` | known/loaded/selected 与切换后 client/SSE 重绑已覆盖 |
| remote directory 误用 | 设计 | 已缓解 | `jsonrpc/client.ts` | 已显式注入 header；保持 server fail-closed 测试 |
| S8 fresh-lane 跨 client | 设计 | 低垂果实 | `prompt-queue.ts` | lane `(scopeKey, sessionId\|clientId)` |
| scheduler_job 已 drop | 设计 | 暂缓 | migrations | 本批不恢复；与 session 级 SchedulerStore 同批落地 |
| 机器级 Heartbeat 串扰 scope | 架构 | 暂缓 | `docs/runtime/heartbeat` 目标态 | 后续按 workspace/session lane 路由，禁止一处 paused 阻塞全机 |
| legacy daemon 与新全局 serve 并存 | 架构 | 战略 | 旧 per-scope pid/state | 一个版本兼容检测与 status/stop 回退，不自动批量 kill |
| problem-lists/server 陈旧 | 风格 | 可修 | docs | README 增加 superseded 顶注并保留历史背景 |

---

## 1.7 关键发现

- **Phase 1 已完成**：用户级 pid/state + InstanceStore + fail-closed routing 已根除主路径的多端口/多 serve 假设。
- **全局面板最小闭环已完成**：known/loaded/selected、可视化切换、切换时 client/snapshot/SSE 重建均已落地。
- **双写预防已有机制与证据**：`claimPendingRun` + `owner_pid` 由真实跨进程集成测试验证，同 session 至多一个 active run。
- **TUI in-process 是特性而非技术债**：与 kimi/claude 一致；不应为「统一」强行 attach。

---

## 1.8 实施进度（2026-07-11）

| 状态 | 内容 | 代码/测试锚点 |
|------|------|---------------|
| 已落地 | 用户级 pid/state、跨 repo 单 server 复用、readiness、精确版本门禁、legacy 当前 cwd 检测、foreground 不 idle-exit | `runtime/daemon/{main,scope,pid-file,state-file}.ts` + 对应单测 |
| 已落地 | InstanceStore、canonical scope、workspace API fail-closed、per-scope backend/coordination/SSE 隔离 | `runtime/{instance-store,workspace-scope}.ts`、`runtime/daemon/server.ts`、`global-server.integration.test.ts` |
| 已落地 | CLI remote 与 Web HTTP/SSE 显式 directory header；跨 repo serve 的 fragment→selected hint | `protocols/jsonrpc/client.ts`、`apps/ohbaby-web/src/api/daemon/*`、`bootstrap.ts` |
| 已落地 | known/loaded/selected 项目列表、可视化切换、切换时 client + snapshot + SSE 重注册 | `workspace-switch.integration.test.ts`、`App.unit.test.tsx` |
| 已落地 | 不耦合 server 包的 TUI serve-awareness、`serve ps` / connections | `serve-awareness.ts`、`serve-awareness.unit.test.ts`、`serve.unit.test.ts` |
| 已验证 | 真实双进程单 listener、TUI+serve 同 session claim | `global-single-serve.integration.test.ts`、`dual-writer-process.integration.test.ts` |
| 后续批次 | per-scope 自动回收、App CORS/鉴权、session 级 `/loop` / Scheduler / Heartbeat | 明确不属于当前第一纵切 |
