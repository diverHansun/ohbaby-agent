# 04 · 多项目 runtime（反多后端的结构保证）

> 这是用户最在意的一条：`ohbaby serve` 绝不能重蹈 daemon「按 cwd 起一堆后台、不可管理」的覆辙。本文定义一个 server 如何**用单进程承载多项目**、如何**全局唯一可发现可停**，并把 G5 精确为「serve 内每 workspace scope 一个 backend」。最终开发契约同时见 [`../../problem-lists/2026-07-11-global-single-daemon/`](../../problem-lists/2026-07-11-global-single-daemon/README.md)。
>
> 前置：[`01`](./01-app-assembly-and-transport.md)、`docs/problem-lists/daemon-workspace-scope/`（病根）、父目录 [`../goals-duty.md`](../goals-duty.md) G5。

---

## 1. 病根回顾（不要重蹈）

旧 daemon 的不可管理来自：**state/pid/workdir 默认绑 `process.cwd()`** → 不同目录启动自然得到不同 daemon →

```
C:\Users\X        daemon pid=7864
D:\Projects       daemon pid=36448
D:\Projects\repo  daemon stopped pid=29852
```

N 个 cwd = N 个后台进程 = 没人能统一查看/停止。修复必须保证：**project 是请求维度，不是进程维度**；**一台机器同一时刻一个 server**。

---

## 2. 三个项目的共同解法（复核结论）

| | 单进程多项目 | 全局发现/管理 |
|---|---|---|
| **opencode** | `serve` `instance:false` 不绑启动 cwd；每请求带 `x-opencode-directory` → 中间件 → `InstanceStore.load({directory})` **懒加载** per-directory instance；`disposeAll()` 回收 | 单 server |
| **kimi** | 默认 in-process 不开 server | **全局单锁** `~/.kimi-code/server/lock`（非 per-cwd）；`server status/stop`；`server ps` → `GET /api/v1/connections` 列连接 |
| **claude-code** | 单 server + in-memory store，session/env 按 id 路由 | 单 server |

ohbaby 采两者之合：**opencode 的请求级 workspace 路由 + kimi 的全局唯一/可发现/ps 语义**；文件实现不照搬 kimi 单 lock，而沿用 ohbaby 现有双文件 pid/state。

---

## 3. workspace 路由（project = 请求维度）

`runtime/workspace-scope.ts` + global server dispatcher（[`01`](./01-app-assembly-and-transport.md) 管线第 4 步）：

```
请求 header: x-ohbaby-directory: <client 当前目录>
  → getProjectRoot(directory)   // 复用 packages/ohbaby-agent/src/project
      ├─ 命中 git root → scopeKey = git root（同 repo 任意子目录归一到此）
      └─ 非 git 目录   → scopeKey = canonical path
  → InstanceStore.load(scopeKey) → 注入 InstanceRef（该 scope 的 backend + coordination）
```

- `ohbaby serve` 启动时**不绑** cwd（对齐 opencode `instance:false`）；它是个多项目宿主。
- web/app 端在每个 workspace 请求与 SSE 连接带 `x-ohbaby-directory`；header 缺失或路径非法返回 400，生产环境不回退 query/cwd。
- jsonrpc `/api/rpc`、`/v1/events` 一律经同一中间件解析 scope。
- `/api/health`、`/api/shutdown`、`/doc` 与静态资源是全局路由，不要求 workspace header。

### scope 规则（落实用户选择：git-root 感知）

| 启动目录 | scopeKey | 同 backend？ |
|------|------|------|
| `repo/`、`repo/sub/a`、`repo/sub/b` | repo 的 git root | ✅ 三者共享 |
| `repo/`（git）vs `/tmp/scratch`（非 git） | git root vs canonical path | ❌ 各自独立 |

> 这是 `docs/problem-lists/daemon-workspace-scope` §5.2 当时被刻意留为产品决策的那条，现已定为 **git-root 感知**。复用既有 `project` 模块的 `getProjectRoot()`，语义＝「一个项目一个 runtime」。

---

## 4. InstanceStore 与生命周期

`runtime/instance-store.ts`：

| 行为 | 语义 |
|------|------|
| `load(scopeKey)` | 已有则返回；无则**懒加载**：建该 scope 的 backend（`createPersistentUiBackendClient`）+ coordination（prompt-queue / permission-router / event-bus / client-view） |
| `disposeAll()` | server 停止时回收所有 scope |

`load()` 缓存启动 Promise，保证同 scope 并发首请求只创建一次；启动失败清除 entry 以便重试。本批不做自动 `dispose(scopeKey)`，所有 scope 随 serve 停止统一回收。

每个 `WorkspaceInstance` = `{ scopeKey, backend, coordination }`，是 serve 进程内该 scope 的唯一 runtime。全机仍允许默认 TUI 与 serve 各自持有 SQLite 连接，因此同 session 互斥由 `run_ledger.claimPendingRun` 保证，不称“全机单写者”。

新增概念（更新到父目录 [`../data-model.md`](../data-model.md)）：
- **WorkspaceInstance**：一个 workspace scope 的 backend + 协调状态集合，按 scopeKey 隔离。
- **ServerRegistry**：机器级的「当前运行的 server」记录（见 §5）。

---

## 5. 全局单一 server（发现 / 管理 / 防重复）

沿用 `runtime/daemon/{pid-file,state-file,supervisor}`，只把发现路径迁到用户级：

- `~/.ohbaby/server/daemon.pid`：`O_EXCL` 独占，记录 PID + startedAt + ownership token。
- `~/.ohbaby/server/daemon-state.json`：listen 成功后原子写入真实 host/port/authToken/packageVersion/pidToken，是连接发现真相。
- 第二启动者遇到 live pid 但 state 尚未 ready 时有限等待；不得把启动中的进程当 stale。
- state 健康且 `packageVersion` 与当前 CLI **精确一致**才复用；版本不同提示显式 stop/start，禁止自动 kill。
- 只有 PID 已死亡才做 stale takeover；stop 必须校验 state.pidToken 与 pid record token。

管理命令（CLI 层，对标 kimi）：

| 命令 | 行为 |
|------|------|
| `ohbaby serve` | 前台启动唯一 server，打印 url + token + 停止方式（G4） |
| `ohbaby serve status` | 读用户级 pid/state + health，报运行状态/地址/版本 |
| `ohbaby serve stop` | 停唯一 server，释放 pid lock，更新/清理 state |
| `ohbaby serve ps` | `GET /v1/connections` 列当前连接（clientId/连接时长/scope/订阅）——可观测，对标 kimi `ps` |

显式 foreground serve 不再沿用“最后客户端断开 15 分钟后退出”的 auto-spawn 语义；它只由 Ctrl+C、`serve stop`、系统退出或异常停止。

---

## 6. G5 细化（与父目录对账）

父目录 [`../goals-duty.md`](../goals-duty.md) G5：「后面只有一个 backend……单写者」。多项目宿主下细化为：

> **serve 内每 workspace scope 一个 backend/runtime**。跨 scope 是多个互不共享 coordination 状态的 backend（由 InstanceStore 隔离），不是「网关聚合多服务」——依赖方向仍 `protocols → coordination → CoreApiHost`，仍无环。同 session 跨 TUI/serve 的写竞争由持久化 claim 解决。

这不破坏 G5 的本意（「不做多服务聚合网关」），只是把「一个 backend」的量词从「全局」精确到「per scope」。指针更新见 [`00`](./00-scope-and-deltas.md) §4。

---

## 7. 顺手修 S8 / S9（Δ10）

| 缺陷 | 修法 |
|------|------|
| **S8** `__fresh__` lane 跨客户端串行 | lane key 改为 `(scopeKey, sessionId ?? clientId)`：不同客户端各自开新会话不再互相串行；同会话仍 FIFO |
| **S9** `disconnectClient` 空 stub | 断连时清该 client **已排队未启动**的 prompt；**已启动的不取消**（N3：不重复执行/扣费），并清其 permission/command 归属 |

---

## 8. 约束与权衡

| 决策 | 放弃的方案 | 代价 |
|------|-----------|------|
| 单 server 多项目（请求级路由） | 每项目一个 server 进程 | 单进程要管多 backend 生命周期；换来「一台机器一个可管理 server」，根除多后端 |
| 用户级 pid/state 双文件 | per-cwd state 文件（旧 daemon）/新造单 lock | 需处理启动中 readiness；换来复用既有 ownership 与原子 state 语义 |
| git-root 感知 scope | canonical-cwd 隔离 | 同 repo 子目录共享 backend（多数时候是期望）；若想强隔离需另开非 git 目录 |
| 懒加载 + 本批仅 disposeAll | 自动 per-scope 回收 | 首次访问有冷启动且已访问 scope 常驻至 stop；避免资源 ownership 未闭合时伪回收 |

---

## 下游消费者指针：ohbaby-web 的 scope 依赖（S-D）

> v0.1.6 的 web 前端（见 [`../../ohbaby-web/`](../../ohbaby-web/README.md)）同源继承单 scope；Option B 后它升级为同一 origin 的全局面板。其设计对本节提出依赖 **S-D**：

- 任意 cwd 执行 `ohbaby serve` 都打开同一个全局面板；当前 canonical scope 只作为初始选中提示，不限制面板可见范围。
- known projects 来自共享 DB 的 `project_root` 与 InstanceStore loaded scopes，不扫描全盘；必须区分 known / loaded / selected。
- 切换 selected project 时，HTTP 与 SSE 一起切换 `x-ohbaby-directory` 并重新注册该 scope 的 client view。
- v0.1.6 Option A 的 per-scope pid/state 保留一个版本兼容检测；不自动批量 kill。

---

## 自检

- project 是请求维度而非进程维度？✅ §3。
- 一台机器是否保证单一可管理 server？✅ §5 用户级 pid/state + status/stop/ps。
- G5 的细化是否与父目录显式对账？✅ §6 + 00 §4。
- S8/S9 有明确修法且不违反 N3？✅ §7。
