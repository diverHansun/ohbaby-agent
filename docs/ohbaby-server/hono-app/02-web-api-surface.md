# 02 · web/app API surface（REST + SSE + SDK）

> 定义浏览器/app 用的资源化 REST + 事件 SSE。当前实现由 Hono route 做显式校验，业务合同以 `ohbaby-sdk` 为权威；OpenAPI 生成仍是可选后续项，不是当前构建链的一部分。
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
| `submitPromptAccepted` | `POST /v1/prompts` | 持久接单后返回 `UiPromptReceipt`；异步，202 + 经 SSE 出结果 |
| `waitForPrompt` | `GET /v1/prompts/:id/completion` | 四种 Prompt 终态均以成功响应返回；HTTP abort 只中止等待 |
| queue edit/cancel | `PATCH/DELETE /v1/prompts/:id` | 必选队列能力；认证 client 不能伪造 owner |
| queue lease | `POST/PATCH/DELETE /v1/prompts/:id/edit-lease` | 获取、续租、释放编辑租约 |
| `abortRun` | `POST /v1/sessions/:id/abort` | 中止当前 run |
| create/select session façade | `POST /v1/sessions`; `PATCH /v1/sessions/:id/select` | 创建或选择会话；由 runtime façade 使用 |
| `archiveSession` | `PATCH /v1/sessions/:id/archive` | 归档会话 |
| `compactSession` | `POST /v1/sessions/:id/compact` | 压缩会话 |
| `getContextWindowUsage` | `GET /v1/sessions/:id/context-window` | 上下文用量 |
| `listCommands` | `GET /v1/commands` | 可用命令 |
| `executeCommand` | `POST /v1/commands` | 执行命令（带 clientInvocationId 归属） |
| `respondPermission` | `POST /v1/permissions/:id` | 审批应答；归属校验失败 → 403（见流 C） |
| `respondInteraction` | `POST /v1/interactions/:id/respond` | 交互应答；REST/RPC 复用同一原子 owner claim |
| `getCurrentModel` | `GET /v1/model` | 当前模型 |
| `probeModelContextWindow` | `POST /v1/model/context-window-probe` | 只读探测，不写模型配置 |
| `connectModel` | `POST /v1/model` | 切换/连接模型 |
| `setSearchApiKey` | `POST /v1/settings/search-api-key` | 设置搜索 key |
| `setPermission` | `PATCH /v1/permission` | 更新 permission mode/level |
| `subscribeEvents` | `GET /v1/events` | **SSE**，带 `Last-Event-ID` replay（见 [`03`](./03-event-replay.md)） |

> `:id` 依 route 分别表示 sessionId、promptId、interactionId 或 permission requestId。所有 workspace 端点都由全局 dispatcher 读取 `x-ohbaby-directory`、解析目标项目并转发到对应 per-scope app（见 [`04`](./04-multi-project-runtime.md)）。

> **非 backend-capability 的端点**另在它处定义：`GET /api/health`（存活探针）、`GET /v1/connections`（连接观测）以及 `GET /doc`。`/doc` 是 `create-app.ts` 手写的信息性 OpenAPI 3.1 文档，不是代码生成链。

### prompt 的异步语义（对齐 SDK）

- `POST /v1/prompts` **不**同步等 run 完成；持久接单后返回 `202 Accepted` + receipt。调用方可只看 SSE，也可携 `promptId` 调 completion route。
- `submitPromptAndWait` 不对应专用 route：remote/browser client 只能组合 accepted + wait 两个 primitive。
- failed/cancelled/interrupted 与 succeeded 一样 resolve `UiPromptCompletion`；查询、权限、传输、存储和等待中止等技术错误才 reject。
- completion 只描述 Prompt 终态，不承载完整回答；回答继续属于 snapshot/event 数据流。

---

## 3. Schema 与校验

每个端点显式校验 `params` / `query` / `json` payload：

- 校验失败 → `400` + 结构化错误（不静默）。
- 领域类型（`UiSnapshot`、`UiEvent`、Prompt DTO 等）**真相在 `ohbaby-sdk`**。REST wrapper（如 `{ok, seqNum, snapshot}`）只存在于 transport；browser client 在边界投影回 SDK DTO。
- **不**在本包重新定义领域语义（守 N5/N1）：schema 描述「线上长什么样」，不描述「领域规则」。

---

## 4. OpenAPI 文档与 typed client

当前 `GET /doc` 返回手写、信息性的 OpenAPI 3.1 文档；没有 zod schema 注册或从 OpenAPI 生成 Web client。`BrowserDaemonClient implements UiBackendClient` 已用 SDK 类型消除业务合同手抄；`DaemonHttpClient` 只是内部 wire helper。只有出现外部非 TypeScript app 消费者、且维护收益超过 schema/生成链成本时，再评估生成链。

- 不把 `/doc` 误写成 `@hono/zod-openapi` 或 client 生成步骤。
- 当前发布门是 SDK contract/typecheck、真实 `app.fetch` 集成、浏览器 client 集成和真实进程 REST/SSE E2E。

---

## 5. 与 jsonrpc 的关系（一张表讲清）

| 维度 | jsonrpc `/api/rpc`（兼容） | web `/v1/*`（新主路径） |
|------|------|------|
| 消费者 | `ohbaby --remote-port`、集成测试 | 浏览器、未来 app |
| 形态 | 单一 POST + method 信封 | 资源化 REST + 状态码 |
| 事件 | `/api/events` SSE（切到新 event-bus） | `/v1/events` SSE（replay） |
| 鉴权/项目路由/协调 | 同一全局 auth/workspace dispatcher；每 scope 独立 coordination + backend | **同一套** |
| 文档/类型 | SDK 派生 method/params | SDK 业务 DTO + 内部 wire wrapper |

要点：两者**不是两套服务**，是同一 Hono app 上架在同一 backend 的两个路由组——这是「不产生只在 web 才有的行为」的结构保证（详见 [`05`](./05-consumption-path-unification.md)）。

---

## 6. 不在本阶段

- 文件上传/下载、pty、workspace 文件树等 opencode 式重端点：YAGNI，按真实 web/app 需求逐个加。
- 鉴权升级为 per-user/JWT：N4，远程 app 立项再做。

---

## 7. 下游消费者指针：ohbaby-web 的依赖（S-A/S-B/S-C）

> v0.1.6 引入的 web 前端模块设计见 [`../../ohbaby-web/`](../../ohbaby-web/README.md)。其设计对本 web surface 提出三项具体依赖，记此避免暗坑（真正实现仍在本包本期/后续）：

- **S-A**：`GET /v1/snapshot` 须在响应中携带它反映的 **seqNum 基线**（`UiSnapshot` 本身无 seq 字段 → 需包成 `{ snapshot, seqNum }` 之类）。web 据此做"SSE 先开 + 只应用 seq>基线的缓冲事件"，杜绝首屏漏拍/重复。
- **S-B**：新增 **webAssets 静态路由**伺服 `apps/ohbaby-web/dist`（同源托管，参考 kimi `routes/webAssets.ts`；含路径穿越防护）。归属：本包新 Duty（CLI 只把 dist 路径喂给 server）。
- **S-C**：向伺服的 `index.html` 注入 `window.__OHBABY__`{token, clientId, baseUrl}，使浏览器免手填 token。归属：本包新 Duty。

> S-B/S-C 是"daemon 同源托管"决策的直接落点；它们在原 delta 清单（00 §2）中未列，属本指针新增。多项目 scope 依赖见 [`04`](./04-multi-project-runtime.md) 末的 S-D 指针。

---

## 自检

- 每个 REST 端点都对应一个既有 backend 能力？✅ §2。
- 是否引入了只在 web 才有的领域行为？无——路由是纯 adapter，语义经 coordination 与 jsonrpc 对齐。
- 手写信息性 `GET /doc` 与暂缓生成链的现状是否和父目录显式对账？✅ §4 + 指针（00 §4）。
