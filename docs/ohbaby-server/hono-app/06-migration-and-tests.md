# 06 · 迁移步骤、依赖与测试验收

> 从当前 `runtime/daemon/server.ts`（手写 http）增量演进到 Hono app + web surface，每步独立 commit、可单独跑门。本文给步骤、新增依赖、测试矩阵与验收/回归红线。
>
> 前置：[`00`](./00-scope-and-deltas.md)~[`05`](./05-consumption-path-unification.md)。续写父目录 [`../migration-sequence.md`](../migration-sequence.md) §6 的「后续 web/app 适配」。

---

## 1. 新增依赖

加入 `packages/ohbaby-server/package.json` `dependencies`：

| 依赖 | 用途 |
|------|------|
| `hono` | app + 路由 + 中间件 |
| `@hono/node-server` | `ohbaby serve` 监听（Node 适配） |
| `@hono/zod-openapi` | zod 路由 + OpenAPI 生成（见 [`02`](./02-web-api-surface.md)） |
| `zod` | schema 校验（若 workspace 已有则复用版本） |

> 守 G2：这些依赖**只进 `ohbaby-server`**，绝不进 `ohbaby-agent`。默认 CLI 直连路径不引入它们（ADR-001）。

---

## 2. 增量步骤（每步一 commit，跑全量门）

### M1 · 抽 client-view（行为不变）
- 从 `server.ts` 平移 `snapshotForClient` / `routeEventForClient` / `activeSessionId` 推进 / command·permission 归属 → `coordination/client-view.ts`（纯函数）。
- `server.ts` 改调 client-view，**行为不变**。
- 补 client-view 单测（[`05`](./05-consumption-path-unification.md) §3.2）。
- 门：现有 `server.integration.test.ts`、`client.integration.test.ts` 全绿。

### M2 · 立 Hono app 骨架 + health（不切流量）
- 新增 `app/create-app.ts`、`transport/in-process.ts`、`transport/node-listen.ts`。
- 仅挂 `GET /health` + 全局 logger/error 中间件。
- `lifecycle/server-main.ts` 暂时**仍用旧 `server.ts`**对外，Hono app 仅自测。
- 门：`app.request("/health")` 单测；包 build/typecheck 通过。

### M3 · jsonrpc 迁到 Hono 路由（兼容，行为不变）
- `protocols/jsonrpc/rpc-route.ts`：把 `callBackend` 挂为 `POST /api/rpc`；`/api/events`、`/api/health`、`/api/shutdown` 迁到 Hono。
- auth 中间件 fail-closed 化（[`01`](./01-app-assembly-and-transport.md) §4）。
- `server-main` 切到 Hono app（经 `node-listen`）。**删除旧 `server.ts` 的 http 部分**。
- 门：现有集成测试改打 Hono app（行为应不变）；`ohbaby --remote-port` 手测连通。

### M4 · event-bus + replay（解 S1）
- `coordination/event-bus.ts`：seqNum + 环形缓冲 + replay（[`03`](./03-event-replay.md)）。
- `/api/events` 与（即将的）`/v1/events` 事件源切到 event-bus；SSE 写 `id: seqNum`，解析 `Last-Event-ID`。
- sdk 增 `ConnectionState` + remote client 重连感知。
- 门：replay 单测（窗内补发 / 窗外 resync）；断线重连集成测试。

### M5 · CORS + web REST/SSE + OpenAPI（解 S2，铺 web/app）
- `middleware/cors.ts`（仅挂 web 路由）。
- `protocols/web/routes.ts` + `schemas.ts`（[`02`](./02-web-api-surface.md)），**复用 client-view + event-bus**。
- `@hono/zod-openapi` + `/doc`。
- 门：web 路由契约测试；跨 transport 等价测试（[`05`](./05-consumption-path-unification.md) §3.1）作为漂移回归门；CORS 预检测试。

### M6 · 多项目 runtime + 用户级 pid/state + serve ps（反多后端）
- `runtime/instance-store.ts`（git-root scope，懒加载/统一回收）、`runtime/workspace-scope.ts`（fail-closed 解析）；唯一性沿用 `runtime/daemon/pid-file.ts` + `state-file.ts`，不新增单 lock 文件。
- CLI 层：`serve status/stop/ps` 接用户级 pid/state + `GET /v1/connections`。
- 修 S8（lane key）/ S9（断连清待决）。
- 门：多 scope 隔离测试；并发启动只起一个 server 测试；`ps` 列连接测试。

> M1–M4 不依赖 web，可先稳住 CLI-remote + replay；M5–M6 才铺 web/app。任何一步可独立审查。

---

## 3. 测试矩阵

| 层 | 覆盖 | 落点 |
|----|------|------|
| 单元 | client-view 投影、event-bus replay、auth fail-closed、cors origin、scope 解析 | `*.unit.test.ts` |
| 契约（跨 transport） | direct vs `app.fetch` 单客户端等价（漂移门） | 新增 `consumption-parity.contract.test.ts` |
| 集成 | jsonrpc `/api/rpc`+SSE、web `/v1/*`+SSE、断线重连、多 scope、并发启动单 server | `*.integration.test.ts` |
| 协调（P2 专属） | prompt FIFO、审批只回发起方、事件过滤、replay 窗外 resync | `coordination/*.unit/integration` |

命令（沿用父目录 [`../migration-sequence.md`](../migration-sequence.md) §8）：
```
pnpm run lint && pnpm run typecheck
pnpm run test:unit && pnpm run test:contract && pnpm run test:integration
pnpm run build
```

---

## 4. 验收标准

**默认 CLI（不得回退，守 ADR-001 / N2）**
- 默认 `ohbaby` 仍直连 backend，**不 import `hono`**（可用 `rg "from \"hono\"" packages/ohbaby-cli packages/ohbaby-agent` 验证为空）。
- 默认启动不创建 server 锁/端口；关窗口无残留。
- 同目录两终端 = 两独立 in-process session（C1 不回退）。

**显式 server**
- `ohbaby serve` 前台启动，打印 url + token + 停止方式；Ctrl+C 干净退出、释放全局锁。
- 同机第二次 `ohbaby serve` **不**起第二个 server（提示已存在）。
- `ohbaby --remote-port` / `attach` 经 jsonrpc 连通；web 端经 `/v1/*` + `/v1/events` 连通。
- SSE 断线重连后**补发**断连区间事件（或收到 resync 信号），状态不发散。
- 同 repo 子目录与 root 命中**同一 backend**；非 git 目录独立。
- auth 未带/错 token → 拒（fail-closed）；web 跨 origin 在白名单内放行、白名单外拦。

**漂移门**
- 跨 transport 契约测试绿：单客户端下 direct 与 `app.fetch` 行为等价。

---

## 5. 回归红线（不得破坏）

- `docs/problem-lists/terminal-daemon/`（终端闪烁修复）。
- `docs/problem-lists/session-view-reset` / `session-switch-regression`（session 切换修复）。
- `docs/ohbaby-server/test.md` 既有 server 包单测/集成。
- 真实环境：真实 API key 跑默认 `ohbaby`；`npm pack` 本机安装验证默认 CLI 与 `serve` 两条路径；关终端无残留。

---

## 6. 审查门禁

- 本地自审：diff、依赖方向（`ohbaby-agent` 不反向 import 本包、不引 hono）、测试覆盖、`npm pack`。
- 子代理分块审查：app/中间件边界、event-bus replay 正确性、多项目锁与 scope、消费路径漂移门。
- 不急 merge / tag / publish——等真实环境验证 + 用户审核。

---

## 7. 不做事项（延续父目录）

- 不把 detached 后台常驻提为默认稳定性方案（N6）。
- 不自动重放 prompt（N3）。
- 不引入 LAN/mDNS/TLS/多用户（N4）。
- 不抽领域事件投影层，projector 保持恒等（N5）。
- 不让默认 CLI 经过 Hono app（ADR-001）。

---

## 自检

- 每步独立可测可审？✅ §2 M1–M6。
- 新增依赖只进本包？✅ §1 + §4 验证命令。
- 漂移有回归门？✅ §3 契约层。
- 验收覆盖默认 CLI + server 两路？✅ §4。
