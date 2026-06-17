# 01 · Hono app 装配与传输

> 把手写 `runtime/daemon/server.ts` 重构为一个 **Hono app + 可注入 fetch + 显式 listen**。本文定义装配结构、中间件管线与次序、生命周期，以及 jsonrpc 兼容路由如何挂在同一 app 上。
>
> 前置：[`00-scope-and-deltas.md`](./00-scope-and-deltas.md)（Δ1/Δ2/Δ6/Δ9）、父目录 [`../architecture.md`](../architecture.md)。

---

## 1. 目标文件布局（在现有结构上演进）

```
packages/ohbaby-server/src/
├── app/
│   ├── create-app.ts         (新) 组装 Hono app：挂中间件 + 各 protocols 路由；返回 { app, dispose }
│   └── openapi.ts            (新) @hono/zod-openapi 注册（见 02）
├── transport/
│   ├── in-process.ts         (新) 给 app.fetch 包一层友好句柄（web/app + 测试用，不开端口）
│   └── node-listen.ts        (新) @hono/node-server 绑定监听 + 优雅关闭 + 端口回退
├── middleware/
│   ├── auth.ts               (现 auth/token.ts 升级为 Hono 中间件，fail-closed)
│   ├── cors.ts               (新) origin 白名单，scope 到 web 路由
│   └── workspace.ts          (新) x-ohbaby-directory → InstanceRef（见 04）
├── protocols/
│   ├── jsonrpc/
│   │   ├── protocol.ts       (保留)
│   │   ├── rpc-route.ts      (新) 由 server.ts 的 callBackend 抽出，挂 Hono 路由
│   │   └── client.ts         (保留) remote UiBackendClient
│   └── web/
│       └── routes.ts         (新) 见 02
├── coordination/
│   ├── prompt-queue.ts       (保留；修 S8)
│   ├── permission-router.ts  (保留；修 S9)
│   ├── client-view.ts        (新) 由 server.ts 抽出的 per-client 视图投影（见 05）
│   └── event-bus.ts          (新) seqNum + 环形缓冲 + replay（见 03）
└── lifecycle/
    └── server-main.ts        (现 runtime/daemon/main.ts 演进) startServer 组合根
```

> `runtime/daemon/server.ts` 迁移后**清空**：路由部分 → `app/` + `protocols/*/`，per-client 视图 → `coordination/client-view.ts`，监听部分 → `transport/node-listen.ts`。`runtime/daemon/{supervisor,state-file,pid-file}` 仍是 detached 降级抽屉（N6），不在本阶段动。

---

## 2. `create-app`：唯一组装点

`create-app.ts` 是 app 的**组合根**，纯函数式装配，**不自己监听端口**：

```
createServerApp(deps): { app: Hono; dispose: () => Promise<void> }
  deps:
    instanceStore   // 多项目 backend 解析（见 04），单项目时退化为固定 backend
    authToken?      // 未配置 = fail-closed 仍要求显式 allow（见 §4）
    corsOrigins?    // web 路由的 origin 白名单
    packageVersion?
```

装配步骤（声明式，替代 `if (pathname===...)`）：
1. 全局中间件：请求日志（结构化）、错误兜底。
2. `GET /health`：无鉴权或轻鉴权的存活探针。
3. web 路由组（带 cors + auth + workspace 中间件）—— 见 [`02`](./02-web-api-surface.md)。
4. jsonrpc 兼容路由组（带 auth + workspace 中间件）—— §5。
5. event SSE 端点（带 auth + workspace + replay）—— 见 [`03`](./03-event-replay.md)。
6. OpenAPI `/doc` —— 见 [`02`](./02-web-api-surface.md)。

`create-app` **只返回 app + dispose**，对「在不在端口上跑」一无所知。这是 Δ2 的关键：同一个 app 既能被 `app.fetch(req)` 直接调，也能被 `node-listen` 挂到端口。

---

## 3. 两种传输：注入式 fetch vs 显式 listen

| 传输 | 入口 | 用途 | 是否开端口 |
|------|------|------|-----------|
| **in-process fetch** | `transport/in-process.ts` 包 `app.fetch` | web/app dev 内嵌、**契约测试 harness** | ❌ |
| **node listen** | `transport/node-listen.ts`（`@hono/node-server`） | `ohbaby serve` | ✅ |

```
// in-process（测试 / 内嵌）
const { app } = createServerApp(deps)
const res = await app.request("/v1/sessions", { headers: { "x-ohbaby-directory": dir } })

// listen（ohbaby serve）
const handle = await startServer(deps)   // lifecycle/server-main.ts
// handle: { url, authToken, stop() }    // 打印 url+token+停止方式（G4）
```

> **注意**：默认 `ohbaby`（交互/`run`）**两种都不走**——它直连 backend（ADR-001）。`app.fetch` 的 in-process 形态是给 web/app 内嵌与测试的，不是给默认 CLI 的。

### 监听与优雅关闭（`node-listen.ts`）

- 端口策略：显式 `port` 用之；`0`/缺省先试 `4096`，被占则取任意空闲口（对齐现有 `DEFAULT_PORT=4096`）。
- 绑定：默认 `127.0.0.1`（N4，不开 LAN）。
- 关闭：`stop()` → 停 prompt-queue → 退订 backend 事件 → 关闭所有 SSE 连接 → `server.close()` → 释放全局锁（见 [`04`](./04-multi-project-runtime.md)）。Ctrl+C / SIGTERM 触发同一路径。

---

## 4. 中间件管线与次序

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

现有 `server.ts` 的 `callBackend(...)` 把 jsonrpc method 映射到 `UiBackendClient`。本阶段：

- `callBackend` 拆出为 `protocols/jsonrpc/rpc-route.ts`，挂为 `POST /api/rpc` 的 Hono handler。
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
