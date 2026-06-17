# 02 · web/app API surface（REST + SSE + OpenAPI/SDK）

> 定义浏览器/app 用的资源化 REST + 事件 SSE，用 zod schema 描述，经 `@hono/zod-openapi` 产出 OpenAPI spec 供 web/app 生成 typed client。
>
> 前置：[`01-app-assembly-and-transport.md`](./01-app-assembly-and-transport.md)（Δ3/Δ4）、[`03-event-replay.md`](./03-event-replay.md)（事件流）。

---

## 1. 设计原则

- **资源化、动词用 HTTP method**：相对 jsonrpc 单一信封，web 端吃 `GET/POST` + 路径 + 状态码（可缓存、可被浏览器/代理理解）。
- **路由是纯 adapter**：路由内**零业务逻辑**——只做 schema 校验 → 调 `CoreApiHost`/coordination → 投影响应。业务在 backend，per-client 视图在 `coordination/client-view`（见 [`05`](./05-consumption-path-unification.md)）。
- **与 jsonrpc 语义一致**：每个 REST 端点对应一个既有 `UiBackendClient` 能力，二者经同一 coordination 落到同一 backend，**不得产生只在 web 才有的行为**。
- **版本前缀 `/v1`**：web/app 合约带版本，jsonrpc 兼容路由保持 `/api/*` 不动。

---

## 2. 资源映射（UiBackendClient → REST）

现有 backend 能力（取自 `server.ts` 的 `callBackend`）逐一映射：

| backend 能力 | REST 端点 | 说明 |
|------|------|------|
| `getSnapshot` | `GET /v1/snapshot` | 经 client-view 投影为该连接视图（见 05） |
| `initializeClient` | `POST /v1/clients` | 建立 client 视图（startup intent：resume/continue/fresh + 初始权限），返回 `clientId` |
| `getSnapshot`(sessions 维度) | `GET /v1/sessions` | 会话列表（投影自 snapshot） |
| `submitPrompt` | `POST /v1/sessions/:id/prompt` | 入 prompt-queue 对应 lane；异步，202 + 经 SSE 出结果 |
| `abortRun` | `POST /v1/sessions/:id/abort` | 中止当前 run |
| `compactSession` | `POST /v1/sessions/:id/compact` | 压缩会话 |
| `getContextWindowUsage` | `GET /v1/sessions/:id/context-window` | 上下文用量 |
| `listCommands` | `GET /v1/commands` | 可用命令 |
| `executeCommand` | `POST /v1/commands/execute` | 执行命令（带 clientInvocationId 归属） |
| `respondPermission` | `POST /v1/permissions/:id` | 审批应答；归属校验失败 → 403（见流 C） |
| `respondInteraction` | `POST /v1/interactions/:id` | 交互应答 |
| `getCurrentModel` | `GET /v1/model` | 当前模型 |
| `connectModel` | `POST /v1/model` | 切换/连接模型 |
| `setSearchApiKey` | `POST /v1/settings/search-api-key` | 设置搜索 key |
| `subscribeEvents` | `GET /v1/events` | **SSE**，带 `Last-Event-ID` replay（见 [`03`](./03-event-replay.md)） |

> `:id` = sessionId。所有端点都经 `x-ohbaby-directory` workspace 中间件解析目标项目（见 [`04`](./04-multi-project-runtime.md)）。

> **非 backend-capability 的端点**另在它处定义，不在上表（上表只映射 `UiBackendClient` 能力）：`GET /health`（存活探针，[`01`](./01-app-assembly-and-transport.md)）、`GET /doc`（OpenAPI，§4）、`GET /v1/connections`（连接观测，供 `serve ps`，[`04`](./04-multi-project-runtime.md) §5）。

### prompt 的异步语义（对齐 N3）

- `POST /v1/sessions/:id/prompt` **不**同步等 run 完成；入队后返回 `202 Accepted` + 该 prompt 的引用。结果（消息增量、run 状态）经 `GET /v1/events` SSE 出。
- server 断开后**不自动重放** prompt（N3）；前端据 `ConnectionState`（见 03）提示用户重提。

---

## 3. Schema 与校验（zod）

每个端点声明 `params` / `query` / `json`(payload) / `response` 的 zod schema：

- 校验失败 → `400` + 结构化错误（不静默）。
- 领域类型（`UiSnapshot`、`UiEvent`、`SessionInfo` 等）**真相在 `ohbaby-sdk`**。做法：在 `protocols/web/schemas.ts` 里为 wire 形状写 zod schema，与 sdk 的 TS 类型**对齐校验**（schema 是 wire 契约，sdk 类型是领域契约；二者一处变更需同步——记入跨模块检查）。
- **不**在本包重新定义领域语义（守 N5/N1）：schema 描述「线上长什么样」，不描述「领域规则」。

---

## 4. OpenAPI 与 typed client（Δ4，激活父目录暂缓项）

> 父目录 [`../non-functional.md`](../non-functional.md) §4 曾把 OpenAPI 列为暂缓（「协议成员只有 jsonrpc+web，未到投资点」）。本阶段 web/app 需要 typed client，投资点已到——本文激活它，并在 06 更新父目录。

- 路由用 `@hono/zod-openapi` 的 `createRoute` 注册；`app/openapi.ts` 汇总后 `GET /doc` 出 **OpenAPI 3 spec**。
- web（TS）：由 spec 生成 typed client（如 `openapi-typescript` + fetch 包装），或直接共享 zod schema 类型。
- app（若非 TS / RN）：由同一 spec 生成对应语言 client。
- **收益**：合约单一来源（路由即文档即类型），web/app 不靠手写、不漂移。
- **代价**：路由要写 zod schema（比裸 Hono 多一层声明）；新增 `@hono/zod-openapi` + `zod` 依赖。值——这正是 web/app 阶段的核心红利。

---

## 5. 与 jsonrpc 的关系（一张表讲清）

| 维度 | jsonrpc `/api/rpc`（兼容） | web `/v1/*`（新主路径） |
|------|------|------|
| 消费者 | `ohbaby --remote-port`、集成测试 | 浏览器、未来 app |
| 形态 | 单一 POST + method 信封 | 资源化 REST + 状态码 |
| 事件 | `/api/events` SSE（切到新 event-bus） | `/v1/events` SSE（replay） |
| 鉴权/项目路由/协调 | **同一套**中间件 + coordination + backend | **同一套** |
| 文档/类型 | 无（信封手写） | OpenAPI 自动出 |

要点：两者**不是两套服务**，是同一 Hono app 上架在同一 backend 的两个路由组——这是「不产生只在 web 才有的行为」的结构保证（详见 [`05`](./05-consumption-path-unification.md)）。

---

## 6. 不在本阶段

- 文件上传/下载、pty、workspace 文件树等 opencode 式重端点：YAGNI，按真实 web/app 需求逐个加。
- 鉴权升级为 per-user/JWT：N4，远程 app 立项再做。

---

## 自检

- 每个 REST 端点都对应一个既有 backend 能力？✅ §2。
- 是否引入了只在 web 才有的领域行为？无——路由是纯 adapter，语义经 coordination 与 jsonrpc 对齐。
- OpenAPI 激活是否与父目录显式对账？✅ §4 + 指针（00 §4）。
