# 01 · Hono app 装配与传输

> 把手写 `runtime/daemon/server.ts` 重构为一个 **Hono app + 可注入 fetch + 显式 listen**。本文定义装配结构、中间件管线与次序、生命周期，以及 jsonrpc 兼容路由如何挂在同一 app 上。
>
> 前置：[`00-scope-and-deltas.md`](./00-scope-and-deltas.md)（Δ1/Δ2/Δ6/Δ9）、父目录 [`../architecture.md`](../architecture.md)。

> **当前实现（2026-10-21）**：`createDaemonServerApp()` 是单 workspace 的 app 组合根，按既有顺序注册拆出的协议路由；`runtime/daemon/server.ts` 继续承担全局 workspace dispatcher 与 InstanceStore 路由。下面 §1–2 描述已落地结构，§4 的独立中间件管线仍是后续规划。

---

## 1. 当前文件布局

```
packages/ohbaby-server/src/
├── app/
│   ├── create-app.ts         组合根、字段、生命周期、鉴权与 mountRoutes 调度
│   ├── openapi.ts            手写信息性 OpenAPI 3.1 `/doc`
│   ├── sse-hub.ts            DaemonSseHub：连接、重放、广播、断线清理
│   └── static-assets.ts      静态资源、MIME、HTML bootstrap 注入
├── transport/
│   └── node-listen.ts       @hono/node-server 监听与关闭
├── protocols/
│   ├── jsonrpc/
│   │   ├── protocol.ts      RPC 信封与校验
│   │   ├── rpc-route.ts     backend dispatcher + registerRpcRoute
│   │   └── client.ts        remote UiBackendClient
│   └── web/
│       ├── request-helpers.ts  请求体限额、解析、错误响应
│       └── routes/
│           ├── context.ts   单 workspace DaemonRouteContext
│           ├── system.ts    /doc、health、shutdown
│           ├── events.ts    客户端初始化、snapshot、两种 SSE 端点
│           ├── sessions.ts  会话读取、变更、中止（多个连续段）
│           ├── subagents.ts 子代理读取、conversation、watch
│           ├── prompts.ts   receipt、提示词变更与 edit-lease
│           ├── commands.ts  命令目录与执行
│           ├── model.ts     模型与搜索设置
│           └── permissions.ts 交互回应、权限设置与回应
├── coordination/            client-view、permission-router、event-bus 等
├── auth/token.ts            Bearer token 校验
└── runtime/
    ├── daemon/              全局 dispatcher、启动/停止与进程发现
    ├── instance-store.ts    per-workspace runtime
    └── workspace-scope.ts   workspace 解析
```

`transport/in-process.ts`、`middleware/` 与 `lifecycle/server-main.ts` 是历史目标布局，当前未因这次结构拆分而新增。`runtime/daemon/server.ts` 保留全局职责，不清空或迁入单 workspace app。

---

## 2. `create-app`：单 workspace 组合根

`createDaemonServerApp(options): DaemonServerAppHandle` 的入口与 `{ app, start, dispose }` 句柄保持不变。它装配同一个 Hono app，不自行监听端口；外层负责 workspace 分派。

`DaemonServerAppRuntime` 实现 `protocols/web/routes/context.ts` 的 `DaemonRouteContext`。协议层只依赖实际需要的 backend、协调器、EventBus、鉴权与生命周期方法。可变集合沿用同一个引用，`permissionEpoch` 通过 getter 实时读取；`/doc` 经 context 方法调用组合根提供的文档构造函数，因此 `protocols/` 不反向引用 `app/`。

`mountRoutes()` 的顺序是正确性约束：先保留 `/v1/*` 活跃刷新中间件和 `onError`，随后依次注册 system、RPC、旧 SSE、client 初始化、session 读取、subagent、prompt receipt、snapshot、Web SSE、commands、model、session 变更、prompt 变更、edit-lease、interaction、permission、session abort，最后是静态资源 `GET /`、`GET /*`。同一领域分散的段使用多个 register 函数；两个路径循环仍保留原顺序。路由继续显式鉴权，未改为中间件。

`start()` 订阅 backend 事件并加载当前 permission epoch；`dispose()` 先中止 waiters、取消订阅，再委托 SSE hub 直接关闭连接、清理计时器/集合/协调状态/重放缓存，最后复位 started。订阅失败仍走 disconnect 流程，并保留 `queueMicrotask` 重新订阅；它与正常 shutdown 的直接 close 语义不同。

---

## 3. 两种传输：注入式 fetch vs 显式 listen

| 传输 | 入口 | 用途 | 是否开端口 |
|------|------|------|-----------|
| **in-process fetch** | 直接调用 `app.fetch` / `app.request` | web/app dev 内嵌、**契约测试 harness** | ❌ |
| **node listen** | `transport/node-listen.ts`（`@hono/node-server`） | `ohbaby serve` | ✅ |

```
// in-process（测试 / 内嵌）
const { app, start } = createDaemonServerApp(options)
await start() // 初始化 backend 订阅
const res = await app.request("/api/health", { headers: { authorization: `Bearer ${token}` } })

// listen（ohbaby serve）
const handle = await startServer(deps)   // runtime/daemon/main.ts
// handle: { url, authToken, stop() }    // 打印 url+token+停止方式（G4）
```

> **注意**：默认 `ohbaby`（交互/`run`）**两种都不走**——它直连 backend（ADR-001）。`app.fetch` 的 in-process 形态是给 web/app 内嵌与测试的，不是给默认 CLI 的。

### 监听与优雅关闭（`node-listen.ts`）

- 端口策略：显式 `port` 用之；`0`/缺省先试 `4096`，被占则取任意空闲口（对齐现有 `DEFAULT_PORT=4096`）。
- 绑定：默认 `127.0.0.1`（N4，不开 LAN）。
- 关闭：`stop()` → 停 prompt-queue → 退订 backend 事件 → 关闭所有 SSE 连接 → `server.close()` → 释放全局锁（见 [`04`](./04-multi-project-runtime.md)）。Ctrl+C / SIGTERM 触发同一路径。

---

## 4. 后续中间件管线与次序（尚未按独立文件落地）

以下是独立中间件的设计目标，不是当前文件清单。当前鉴权仍由 handler 显式调用，workspace 在外层 dispatcher 中处理，CORS 白名单 middleware 仍是后续规划。这次只拆分现有函数与路由，不实现这条目标管线。

次序是正确性的一部分（鉴权必须在业务之前，CORS 预检必须最先）：

```
请求 ─► [1 logger] ─► [2 cors(仅 web)] ─► [3 auth(fail-closed)] ─► [4 workspace] ─► 路由 handler ─► [error 兜底]
```

| # | 中间件 | 关键约束 | 解决 |
|---|--------|---------|------|
| 1 | logger | 结构化日志：连接建立/断开、replay 区间、auth 拒因（default CLI 无此负担） | 可观测性 |
| 2 | cors | **仅挂 web 路由**；origin 白名单 = 配置 origins + `http://localhost:{port}` + `http://127.0.0.1:{port}`；预检 `OPTIONS` 先返回 | S2 |
| 3 | auth | **fail-closed**：token 未配置或不匹配一律拒；**常量时间比较**；`Authorization: Bearer <token>` | S4 |
| 4 | workspace | 读 `x-ohbaby-directory` → `getProjectRoot` 归一 → 注入 `InstanceRef`（见 04） | 多项目 |

> auth fail-closed 的具体语义：现有 `isAuthorizedDaemonRequest` 在 token 为空时 `return true`（fail-open）。本阶段中间件层在「server 已配置 token」时严格校验；「未配置 token」视为**配置错误**而非放行——`startServer` 必须保证总是生成 token（现状 `main.ts` 已如此），中间件不再兜 fail-open 这条路。

---

## 5. jsonrpc 兼容路由（Δ9）

`protocols/jsonrpc/rpc-route.ts` 的 `callDaemonBackend(...)` 把 jsonrpc method 映射到 backend；`registerRpcRoute(app, ctx)` 现在负责挂载原有 `POST /api/rpc` handler：

- `registerRpcRoute` 保留鉴权、请求体限额、控制器注册与 finally 清理、绑定通知和原错误映射。`MAX_REQUEST_BODY_BYTES` 移到 `protocols/web/request-helpers.ts`，并继续从 `rpc-route.ts` re-export。
- per-client 视图逻辑（`snapshotForClient` 等）**不留在这里**，移到 `coordination/client-view.ts`，由 rpc-route 与 web routes 共同调用（见 [`05`](./05-consumption-path-unification.md)）。
- `/api/events`（旧 SSE）保留为兼容端点，但其事件源切到新的 event-bus（获得 replay 能力）。
- `/api/health`、`/api/shutdown` 保留。

目的：`ohbaby --remote-port` 现有 remote client（`protocols/jsonrpc/client.ts`）**零改动**仍可用；jsonrpc 与 web 是**同一 app 上的两个路由组**，共享 auth/workspace/coordination，不是两套服务。

---

## 6. 约束与权衡

| 决策 | 放弃的方案 | 代价 |
|------|-----------|------|
| `create-app` 不自带 listen | app 内部直接 `server.listen` | 多一层 transport 包装；换来 `app.fetch` 可注入（测试不开端口、web 可内嵌） |
| jsonrpc 降为同 app 路由组 | 立即删除 jsonrpc 只留 web | 多维护一个兼容路由组；换来 `--remote-port` 平滑过渡、不破坏现有集成测试 |
| 中间件 cors 仅挂 web | 全局 cors | 路由分组时要记得挂；换来 jsonrpc/CLI 路径不背 cors 语义 |
| auth 不再 fail-open | 保留空 token 放行 | 测试需显式给 token；换来 defense-in-depth（S4） |

---

## 自检

- 每个新文件能说出职责？✅ §1 表。
- app 与「是否监听」解耦？✅ §2/§3。
- 中间件次序明确且可追溯到 S2/S4？✅ §4。
- jsonrpc 过渡不破坏现有 remote client？✅ §5。
