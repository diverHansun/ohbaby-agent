# 02 · web/app API surface（REST + SSE + SDK）

> 定义浏览器/app 用的资源化 REST + 事件 SSE。当前实现由 Hono route 做显式校验，业务合同以 `ohbaby-sdk` 为权威；OpenAPI 生成仍是可选后续项，不是当前构建链的一部分。
>
> 前置：[`01-app-assembly-and-transport.md`](./01-app-assembly-and-transport.md)（Δ3/Δ4）、[`03-event-replay.md`](./03-event-replay.md)（事件流）。

---

## 1. 设计原则

- **资源化、动词用 HTTP method**：相对 jsonrpc 单一信封，web 端吃 `GET/POST` + 路径 + 状态码（可缓存、可被浏览器/代理理解）。
- **路由是 adapter**：只做请求校验、调用已有 backend/coordination 或 agent 配置能力、投影响应。聊天业务在 backend，配置业务在 agent 的配置模块，per-client 视图在 `coordination/client-view`（见 [`05`](./05-consumption-path-unification.md)）。
- **既有聊天操作与 jsonrpc 语义一致**：二者经同一 coordination 落到同一 backend。新增 Settings 资源仅提供 HTTP 接口，不扩充 `UiBackendClient` 或 JSON-RPC 方法表；SDK 只提供其请求、响应和事件类型。
- **版本前缀 `/v1`**：web/app 合约带版本，jsonrpc 兼容路由保持 `/api/*` 不动。

---

## 2. 资源映射（UiBackendClient → REST）

当前实例 handlers 位于 `protocols/web/routes/` 的 system、events、sessions、subagents、prompts、commands、model、permissions、settings 模块，由组合根注册。`context.ts` 提供单 workspace 的 `DaemonRouteContext`；不依赖全局 `InstanceStore`，也不反向 import `app/`。`global-settings.ts` 由 daemon 在工作区分发前单独注册，通过窄接口取得鉴权、已加载目录和通知能力。共享请求解析与错误映射在 `protocols/web/request-helpers.ts`，请求体上限仍是 1 MiB。

现有 backend 能力（取自 `server.ts` 的 `callBackend`）逐一映射：

| backend 能力                 | REST 端点                                            | 说明                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `getSnapshot`                | `GET /v1/snapshot`                                   | 经 client-view 投影为该连接视图（见 05）                                                                                              |
| `initializeClient`           | `POST /v1/clients`                                   | 建立 client 视图（startup intent：resume/continue/fresh + 初始权限），返回 `clientId` 及 epoch/root/bindingGeneration；仅查轻量元数据 |
| `submitPromptAccepted`       | `POST /v1/prompts`                                   | 持久接单后返回 `UiPromptReceipt`；异步，202 + 经 SSE 出结果                                                                           |
| `waitForPrompt`              | `GET /v1/prompts/:id/completion`                     | 四种 Prompt 终态均以成功响应返回；HTTP abort 只中止等待                                                                               |
| queue edit/cancel            | `PATCH/DELETE /v1/prompts/:id`                       | 必选队列能力；认证 client 不能伪造 owner                                                                                              |
| queue lease                  | `POST/PATCH/DELETE /v1/prompts/:id/edit-lease`       | 获取、续租、释放编辑租约                                                                                                              |
| `abortRun`                   | `POST /v1/sessions/:id/abort`                        | 中止当前 run                                                                                                                          |
| create/select session façade | `POST /v1/sessions`; `PATCH /v1/sessions/:id/select` | 仅验证/更新轻量元数据及客户端绑定，返回 root/bindingGeneration；不等待聊天快照                                                        |
| `archiveSession`             | `PATCH /v1/sessions/:id/archive`                     | 归档会话                                                                                                                              |
| `compactSession`             | `POST /v1/sessions/:id/compact`                      | 压缩会话                                                                                                                              |
| `getContextWindowUsage`      | `GET /v1/sessions/:id/context-window`                | 上下文用量                                                                                                                            |
| `listCommands`               | `GET /v1/commands`                                   | 可用命令                                                                                                                              |
| `executeCommand`             | `POST /v1/commands`                                  | 执行命令（带 clientInvocationId 归属）                                                                                                |
| `getSessionIndex`            | `GET /v1/sessions/index`                             | 根会话元数据，不读取 messages/runs/todos/model                                                                                        |
| `getPermissionSnapshot`      | `GET /v1/permissions`                                | 独立审批快照；请求带预期 epoch/root/bindingGeneration                                                                                 |
| `respondPermission`          | `POST /v1/permissions/:id`                           | 同根范围一次应答；JSON body 的 context 携带预期绑定                                                                                   |
| `respondInteraction`         | `POST /v1/interactions/:id/respond`                  | 交互应答；REST/RPC 复用同一原子 owner claim                                                                                           |
| `getCurrentModel`            | `GET /v1/model`                                      | 当前模型                                                                                                                              |
| `probeModelContextWindow`    | `POST /v1/model/context-window-probe`                | 探测输入配置；匹配当前连接时沿用能力写回                                                                                                                |
| `connectModel`               | `POST /v1/model`                                     | 切换/连接模型                                                                                                                         |
| `setSearchApiKey`            | `POST /v1/settings/search-api-key`                   | 设置搜索 key                                                                                                                          |
| `setPermission`              | `PATCH /v1/permission`                               | 更新 permission mode/level                                                                                                            |
| `subscribeEvents`            | `GET /v1/events`                                     | **SSE**，带 `Last-Event-ID` replay（见 [`03`](./03-event-replay.md)）                                                                 |

> `:id` 依 route 分别表示 sessionId、promptId、interactionId 或 permission requestId。所有 workspace 端点都由全局 dispatcher 读取 `x-ohbaby-directory`、解析目标项目并转发到对应 per-scope app（见 [`04`](./04-multi-project-runtime.md)）。

> **非 backend-capability 的端点**另在它处定义：`GET /api/health`（存活探针）、`GET /v1/connections`（连接观测）以及 `GET /doc`。`/doc` 由 system 路由经 context 获取 `app/openapi.ts` 中手写的信息性 OpenAPI 3.1 文档，不是代码生成链。

`POST /v1/model` 与 `POST /v1/model/context-window-probe` 的 JSON body 共用协议字段 `interfaceProvider`，只接受 `openai-compatible`、`openai-responses`、`anthropic`。显式合法值优先于 `baseUrl` 推断；缺字段时保留 URL 推断，OpenAI 形状地址默认 Chat Completions。空字符串、`null` 或其他非法显式值返回 `400`。更新 key、窗口或输出上限时应继续传递原协议。

### Settings HTTP 资源

以下新接口都要求 Bearer token，不要求注册 client。全局接口不需要 `x-ohbaby-directory`，只在带 `InstanceStore` 的多项目 daemon 上挂载，按精确路径注册；不能用 `/v1/settings/*` 通配截走实例接口或旧搜索入口。只写全局配置，项目配置仍是只读覆盖。

| 全局接口 | 请求与结果 |
|---|---|
| `GET /v1/settings/models` | 返回 `active: { id, provider, model } \| null`、全局生成 `params` 和按保存顺序排列的 `models`；读取不发网络请求 |
| `POST /v1/settings/models/profiles` | 保存完整连接的新条目，生成独立 id 并追加；不查重、不自动选择，首个条目也如此 |
| `PATCH /v1/settings/models/profiles/:id` | 只修改给出的字段，保留 id 和位置；修改当前项会更新当前配置快照，下一轮生效 |
| `DELETE /v1/settings/models/profiles/:id` | 删除整个条目，保留 `.env` key；删除当前项按原列表顺延并循环 |
| `DELETE /v1/settings/models/providers/:providerId` | 删除该 provider 的全部条目并保留 key；路径参数须 URL 编码，允许名称含 `/` |
| `POST /v1/settings/models/active` | 以 `id` 明确选择已保存且完整的条目，下一轮生效，不改变顺序 |
| `POST /v1/settings/models/probe` | 以 `id` 获取上下文窗口和推理能力，结果写回目标条目，返回 `{ ok: true, reasoning }`，不改变当前选择 |
| `GET /v1/settings/search` | 返回 provider、key 引用及是否已配置、地址和 defaults，不返回 key 值 |
| `PUT /v1/settings/search` | 只合并出现的字段，defaults 按字段合并，`baseUrl: null` 清除地址 |
| `GET /v1/settings/mcp/servers` | 只列全局文件中的服务器配置；凭据返回 `envKeys`、`headerKeys`，不返回值 |
| `PUT /v1/settings/mcp/servers/:name` | 新增、修改或启停一个服务器；`env`、`headers` 使用 `{ set?, unset? }` 补丁；返回已加载项目中的 `overriddenIn` |
| `DELETE /v1/settings/mcp/servers/:name` | 只删除全局条目，不删除项目覆盖；不存在返回 404 |
| `GET /v1/settings/about` | 返回实际版本、ohbaby home、默认工作区；日志启用时附实际 diagnostics 文件及其所在目录 |

模型读取以及新增、编辑、选择、删除都返回 `{ ok: true, active, params, models }` 的完整有序视图；`params` 只读，本轮不增加全局生成参数编辑接口。完整请求和响应类型见 [SDK settings 契约](../../../packages/ohbaby-sdk/src/contract/settings.ts)。

明确选择、编辑当前项或删除当前项后自动顺延时，若目标的已知能力与旧推理档位不兼容，复用已有逻辑清除该推理偏好，避免下一轮因旧档位失败；未知能力和兼容的偏好保留，候选保存不改变当前偏好。

模型条目各自保存 provider、上游模型名、地址、协议和 key 引用，可用 `label` 备注区分。同 provider 不共享可编辑连接配置。协议限 `openai-compatible`、`openai-responses`、`anthropic`。编辑、选择和后台写回均不重排。删除顺延只跳过本地配置不完整的历史条目，不因网络状态或能力未知跳过；没有完整候选时返回 `active: null`，新轮次不能继续使用已删除模型。

保存先完成本地写入，后台再读取元数据；候选条目不会主动发送聊天探测。保留已有显式能力覆盖；自动能力来源依次为内置规则、上游元数据和必要时的主动探测，旧自动缓存不会盖过内置规则或新获取的结果；内置规则按官方地址、模型及协议判断，不依赖用户自定的 provider 名称。未知能力沿用 `service-default`，不注入未经确认的推理参数。新 probe 按 id 写回指定条目。旧 `POST /v1/model/context-window-probe` 保留既有行为：输入匹配当前连接时可写回发现结果，草稿或非当前连接只读取元数据，不选择模型。

模型与搜索 key 使用三态：不传 `apiKey` 保持，空字符串清除目标的使用，非空字符串替换。`apiKeyEnv: null` 明确解除引用。共享引用会先隔离，不能覆盖或删除其它模型或搜索仍使用的值；删除模型或服务商不清理 key。搜索沿用外部 shell 的解析优先级，响应中的 `apiKeyConfigured` 按实际解析结果报告。成功响应的 URL 凭据和错误信息会脱敏；MCP `args` 按合同原样返回。

| 实例接口（还需 `x-ohbaby-directory`） | 结果与代价 |
|---|---|
| `GET /v1/settings/mcp/status` | 当前目录的实际连接、来源、脱敏错误和过滤后的工具；首次读取会初始化连接，已初始化时保持已应用状态 |
| `POST /v1/settings/mcp/reconnect` | 只重连该目录，等待连接和工具刷新；轮次、子代理、后台工具等尚忙时返回 409 `INSTANCE_BUSY` |
| `GET /v1/settings/skills` | 经共享 Skill 注册表刷新后返回元数据，与模型可用工具保持一致 |
| `GET /v1/settings/agents` | 返回该目录生效的 agent 元数据和 builtin/global/project 来源 |

新增实例读取与重连不要求已配置模型。模型条目不存在返回 404；选择或探测未补齐的历史条目返回 400 `MODEL_CONFIG_INCOMPLETE`。普通校验失败返回安全的 400 错误，不把原始请求体或凭据放进响应。

旧 `POST /v1/model`、TUI `/connect` 和 `POST /v1/settings/search-api-key` 保留入口及响应合同，复用相同 agent 写入逻辑。`/connect` 按 provider、模型名、规范化地址取列表中首个匹配项，更新并启用；匹配不含协议或 key，未命中才追加。旧模型入口只向当前实例发布 `model.invalidated`；旧搜索 key 入口不发布 `settings.changed`。新全局写入通知所有已加载实例。配置仍由下一轮的版本检查应用，详见 [`04`](./04-multi-project-runtime.md)。

### 子代理只读会话

`GET /v1/sessions/:id/subagents/:subagentId/conversation` 对应 `getSubagentConversationView`，支持有界 before/after 分页及 `anchorExecutionId`。返回历史窗口、实时投影基线和相关执行状态；旧记录缺少消息锚点时明确返回定位不可用，不根据 prompt 文本猜测消息。

同路径的 `/watch` 通过 POST/DELETE 对应 `watchSubagentConversation` / `unwatchSubagentConversation`。每个 client 同时订阅一个逻辑子代理，仍使用现有 SSE。coordination 校验 root、绑定代际和 scope，客户端同步分配单调 `watchSequence`，coordination 在异步读取前拒绝低序请求，避免网络倒序覆盖新选择；客户端预分配 ID 让未收到响应的请求也可以取消。释放旧 ID 不影响后来的选择；根绑定改变时释放订阅。以上三个能力在 JSON-RPC 中具有同义方法。

### prompt 的异步语义（对齐 SDK）

- `POST /v1/prompts` **不**同步等 run 完成；持久接单后返回 `202 Accepted` + receipt。调用方可只看 SSE，也可携 `promptId` 调 completion route。
- `submitPromptAndWait` 不对应专用 route：remote/browser client 只能组合 accepted + wait 两个 primitive。
- failed/cancelled/interrupted 与 succeeded 一样 resolve `UiPromptCompletion`；查询、权限、传输、存储和等待中止等技术错误才 reject。
- completion 只描述 Prompt 终态，不承载完整回答；回答继续属于 snapshot/event 数据流。

---

## 3. Schema 与校验

每个端点显式校验 `params` / `query` / `json` payload：

- 校验失败 → `400` + 结构化错误（不静默）。
- 领域类型（`UiSnapshot`、`UiEvent`、Prompt DTO 等）**真相在 `ohbaby-sdk`**。既有聊天 REST wrapper（如 `{ok, seqNum, snapshot}`）由 transport 投影；新 Settings 的完整请求/响应类型定义在 SDK `contract/settings.ts`，`settings.changed` 加入现有事件联合并从包入口导出。
- **不**在本包重新定义领域语义（守 N5/N1）：schema 描述「线上长什么样」，不描述「领域规则」。

---

## 4. OpenAPI 文档与 typed client

当前 `GET /doc` 返回手写、信息性的 OpenAPI 3.1 文档，包含 Settings 的全局与实例接口；没有 zod schema 注册或从 OpenAPI 生成 Web client。`BrowserDaemonClient implements UiBackendClient` 已用 SDK 类型消除既有业务合同手抄；`DaemonHttpClient` 只是内部 wire helper。本轮不新增 SDK HTTP 客户端，也不实现 Settings 前端入口。只有出现外部非 TypeScript app 消费者、且维护收益超过 schema/生成链成本时，再评估生成链。

- 不把 `/doc` 误写成 `@hono/zod-openapi` 或 client 生成步骤。
- 当前发布门是 SDK contract/typecheck、真实 `app.fetch` 集成、浏览器 client 集成和真实进程 REST/SSE E2E。

---

## 5. 与 jsonrpc 的关系（一张表讲清）

| 维度               | jsonrpc `/api/rpc`（兼容）                                               | web `/v1/*`（新主路径）          |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------- |
| 消费者             | `ohbaby --remote-port`、集成测试                                         | 浏览器、未来 app                 |
| 形态               | 单一 POST + method 信封                                                  | 资源化 REST + 状态码             |
| 事件               | `/api/events` SSE（切到新 event-bus）                                    | `/v1/events` SSE（replay）       |
| 鉴权/项目路由/协调 | 同一全局 auth/workspace dispatcher；每 scope 独立 coordination + backend | **同一套**                       |
| 文档/类型          | SDK 派生 method/params                                                   | SDK 业务 DTO + 内部 wire wrapper |

既有聊天操作通过同一 Hono app 和 backend 保持 REST/RPC 语义一致（详见 [`05`](./05-consumption-path-unification.md)）。Settings 是新增的 HTTP 资源面，复用 agent 配置逻辑和实例内部能力，不因此扩充 JSON-RPC 方法表。

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

- 既有聊天 REST/RPC 是否保持同义？✅ §2、§5；新增 Settings 的 HTTP-only 边界已单独说明。
- Settings 是否复用配置与实例能力，而未引入第二套运行时或 SDK HTTP 客户端？✅ §2、§3。
- 手写信息性 `GET /doc` 与暂缓生成链的现状是否和父目录显式对账？✅ §4 + 指针（00 §4）。
