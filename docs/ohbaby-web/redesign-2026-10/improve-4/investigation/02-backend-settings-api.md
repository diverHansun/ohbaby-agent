# 2. 后端设置接口现状

2026-10-24 调查。路径相对 `packages/`。设置议题文档指 `docs/problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-2/`，下文简称“设置 improve-2”。

## 已证实事实

### 2.1 路由清单

全局层：`ohbaby-server/src/protocols/web/routes/global-settings.ts` 的 `registerGlobalSettingsRoutes`。只在 daemon 有 InstanceStore 时挂载（`ohbaby-server/src/runtime/daemon/server.ts` `mountRoutes` L282），不需要目录头。

| 方法与路径 | 请求校验 | 响应 | 行号 |
|---|---|---|---|
| GET `/v1/settings/models` | — | `UiSettingsModelsResponse` | L97 |
| POST `/v1/settings/models/profiles` | `ModelEntryCreateSchema` | `UiSettingsModelsResponse` | L106 |
| PATCH `/v1/settings/models/profiles/:id` | `ModelEntryPatchSchema` | `UiSettingsModelsResponse` | L126 |
| POST `/v1/settings/models/active` | `ModelEntrySelectSchema`（`{id}`），并在后台触发能力探测 | `UiSettingsModelsResponse` | L147 |
| POST `/v1/settings/models/probe` | `ModelEntrySelectSchema` | `UiSettingsModelProbeResponse` | L169 |
| DELETE `/v1/settings/models/profiles/:id` | — | `UiSettingsModelsResponse` | L185 |
| DELETE `/v1/settings/models/providers/:providerId` | — | `UiSettingsModelsResponse` | L199 |
| GET `/v1/settings/about` | — | `UiSettingsAboutResponse` | L213 |
| GET `/v1/settings/search` | — | `UiSettingsSearchResponse` | L228 |
| PUT `/v1/settings/search` | `SearchSettingsPatchSchema` | `UiSettingsSearchResponse` | L237 |
| GET `/v1/settings/mcp/servers` | — | `UiSettingsGlobalMcpServersResponse` | L255 |
| PUT `/v1/settings/mcp/servers/:name` | `McpServerPatchSchema` | `UiSettingsMcpServerUpdateResponse` | L264 |
| DELETE `/v1/settings/mcp/servers/:name` | — | `UiSettingsMcpServerDeleteResponse` | L288 |

模型的修改用的是 **PATCH**，不是 PUT。全局路由用 `satisfies` 绑定 SDK 类型（`ohbaby-sdk/src/contract/settings.ts`）。

实例层：`routes/settings.ts` 的 `registerSettingsRoutes`，由 `create-app.ts` L312 挂载，没有用 `satisfies` 绑定类型。

| 方法与路径 | 响应形状 | 行号 |
|---|---|---|
| POST `/v1/settings/mcp/reconnect` | `{ ok: true, servers }`，实例忙时 409 `INSTANCE_BUSY` | L10 |
| GET `/v1/settings/mcp/status` | `{ ok: true, servers }` | L46–81 |
| GET `/v1/settings/skills` | `{ ok: true, skills }` | 同上 |
| GET `/v1/settings/agents` | `{ ok: true, agents }` | 同上 |

旧接口 `POST /v1/settings/search-api-key` 在 `routes/model.ts` L109（实例层）。OpenAPI 描述在 `ohbaby-server/src/app/openapi.ts` L432–625。

### 2.2 错误的返回形状

共享 helper（`ohbaby-server/src/protocols/web/request-helpers.ts` L36）不带 code：

```ts
export function webErrorBody(message: string): unknown {
  return { error: { message }, ok: false };
}
```

全局设置路由的 `handle` 包装（`global-settings.ts` L50–93）：

| 情况 | 状态码 | 返回 | 有没有 code |
|---|---|---|---|
| 未授权 | 401 | `Unauthorized` | 无 |
| `MODEL_NOT_FOUND` | 404 | 内联 `{ ok: false, error: { code, message } }` | 有 |
| `MODEL_CONFIG_INCOMPLETE` | 400 | 同上 | 有 |
| `MCP_SERVER_NOT_FOUND` | 404 | `Global MCP server not found` | **无**，code 被丢掉 |
| `VALIDATION_FAILED` 或 `ZodError` | 400 | `Invalid settings` | **无**，也没有字段信息 |
| 其他 | 500 | `Unable to access settings` | 无 |

agent 侧已经产生的错误码：

- `ModelSettingsError`：`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE`（`ohbaby-agent/src/config/llm/writer.ts` L171–179）。
- `McpServerNotFoundError`：`MCP_SERVER_NOT_FOUND`（`ohbaby-agent/src/config/mcp/writer.ts` L43–48）。
- `McpConfigValidationError`：`VALIDATION_FAILED`，带 `issues`（`ohbaby-agent/src/config/mcp/types.ts` L42–56）。
- `SearchConfigError`：`VALIDATION_FAILED`，带 `context.issues`（`ohbaby-agent/src/config/tools/search/validation.ts` L23、`types.ts` L5–32）。

也就是说，agent 侧已经有 issues，只是 `handle` 没有把它们传出去。

其他路由的错误格式：

- 实例 app 的 `onError` 返回 `{ ok: false, error: { message, code? } }`，并按 code 映射状态码（`ohbaby-server/src/app/create-app.ts` L270–300）。
- `promptRejectionBody`、`promptErrorBody`、`unauthorizedBody`、`requestTooLargeBody` 各有自己的形状（`request-helpers.ts` L25–59，`protocols/jsonrpc/protocol.ts` L199）。
- daemon 自己的路由内联写 code，如 `INVALID_JSON`、`INVALID_DIRECTORY`、`WORKSPACE_NOT_REGISTERED`（`server.ts` L451、467、503、610、782）。

大体都是 `{ ok: false, error: { message, code? } }`，但带不带 code 不统一。

### 2.3 SDK 里的错误类型

- 没有通用的错误体类型或 ErrorCode 联合类型。
- 现有相关定义：`UiSettingsInstanceBusyResponse`（`contract/settings.ts` L132–135）、`isStableErrorCode`（`contract/error-code.ts` L1–5，正则 `/^[A-Z0-9_:-]{1,64}$/`）、`UiPromptError`（`contract/prompt.ts` L33）、`SESSION_MOVED_ERROR_CODE`（`contract/global-sessions.ts` L4）。
- `MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE`、`MCP_SERVER_NOT_FOUND`、`VALIDATION_FAILED` 都还没有进入 SDK 类型。

### 2.4 通用失败的返回

| 情况 | 返回 | 有没有 code |
|---|---|---|
| 鉴权失败（设置路由） | 401 `Unauthorized` | 无 |
| 非法 JSON | 400 `Request body must be valid JSON`（`request-helpers.ts` L345–352） | 无 |
| 请求体超过 1 MiB | 413 `Request body is too large` | 无 |
| 实例后端缺方法 | 503 `Settings reads are unavailable` | 无 |
| daemon 关闭中 | 503 `Daemon server is closing`（`server.ts` L267–273） | 无 |
| 目录百分号编码非法 | 400 `INVALID_DIRECTORY`（`server.ts` L782） | 有 |
| 非 daemon 下缺目录头 | 400 `x-ohbaby-directory is required`（`settings.ts` L13、L56） | 无 |

空请求体按 `{}` 处理（`request-helpers.ts` L342）。

### 2.5 `settings.changed` 与 `model.invalidated`

- 事件类型 `UiSettingsChangedEvent { type: "settings.changed", domains }`，`domains` 可取 model、env、search、mcp、agents、skills（`ohbaby-sdk/src/contract/events.ts` L223–233）。
- 发出位置：`ohbaby-agent/src/adapters/ui-inprocess.ts` L4187–4189 的 `notifySettingsChanged`。`domains` 含 model 时，再经 `publishModelInvalidation`（L2053）发 `model.invalidated`。
- 全局写入后，`server.ts` L208–219 对所有已加载实例广播（`Promise.allSettled`，投递失败不影响写入）。没加载的实例不会收到，之后加载时读到的是新配置。
- 各写入对应的 domains：模型的增、改、设为默认、删除条目、删除 provider 都是 `["model"]`，后台探测完成也会发 `["model"]`（L94–96）；probe 本身不发；PUT search 发 `["search"]`；MCP 的 PUT、DELETE 发 `["mcp"]`。

### 2.6 模型与搜索的 DTO

`UiSettingsModel`（`contract/settings.ts` L167–181，由 `writer.ts` `projectSettings` L223–276 生成）：

- 必有：`id`、`provider`、`model`、`apiKeyConfigured`、`configurationComplete`、`contextWindowTokens`、`reasoning`。
- 可选（不存在时省略，不是 null）：`label`、`baseUrl`、`interfaceProvider`、`promptCache`、`apiKeyEnv`、`maxOutputTokens`。
- 外层 `UiSettingsModels` 有 `active`（`{ id, provider, model } | null`）、`params`、`models[]`。
- 读取时从不返回 key 原文或掩码，只返回 `apiKeyEnv` 和 `apiKeyConfigured`。`baseUrl` 经 `redactSettingsUrl` 脱敏（`ohbaby-agent/src/config/secrets/redaction.ts` L4–29）。
- 写入（`patchEntry` L289–348）：`apiKey` 不传则保留；`""` 或 `apiKeyEnv: null` 删除条目上的引用；非空值写入 `.env`，变量名优先用现有引用，否则用 `OHBABY_MODEL_<ID>_API_KEY`，与他处共用时自动加后缀。`label: null` 清除标签。
- 请求 schema（`writer.ts` L136–168）：create 是 strict，`provider`、`model`、`baseUrl`、`interfaceProvider` 必填；patch 是 create 的 partial，另外允许 `label: null`。

`UiSettingsSearch`（`contract/settings.ts` L57–80，`ohbaby-agent/src/config/tools/search/writer.ts` L65–91）：

- `provider` 固定为 `tavily`；`apiKeyEnv: string | null`；`apiKeyConfigured`；`baseUrl?`（已脱敏）；`defaults { searchDepth, maxResults (1–20), topic, timeout (1–600) }`。
- 写入（`updateSearchSettings` L97–196）：`apiKey` 不传则保留；非空写入 `.env`；`""` 时，如果是受管变量且没有被模型引用就从 `.env` 删除，否则把 `apiKeyEnv` 置为 null。`baseUrl: null` 清除，`defaults` 按字段合并。

### 2.7 MCP 的读取与状态

- 全局配置读取（`ohbaby-agent/src/config/mcp/writer.ts` `projectServer` L57–84）：env、headers 只返回键名（`envKeys`、`headerKeys`）；`url` 脱敏；stdio 的 `args` 原样返回（契约规定，设置 improve-2 02 L130）。
- `UiSettingsGlobalMcpServer`（`contract/settings.ts` L90–104）：`name`、`transport`、`enabled`、`trust`、`timeout`、`includeTools?`、`excludeTools?`、`command?`、`args?`、`cwd?`、`url?`、`envKeys`、`headerKeys`。
- 状态 `UiSettingsMcpServer`（L8–16，`ohbaby-agent/src/services/settings/reader.ts` L20–50）：`name`、`origin`（global/project/plugin）、`enabled`、`status`（connected/failed/disconnected/disabled）、`error?`（仅 failed 时，已脱敏）、`toolCount`、`tools[]`。

### 2.8 现有测试

- 全局层：`ohbaby-server/src/app/settings-global.integration.test.ts`（861 行）。用真实 daemon HTTP 服务加进程内后端，`request()` helper 在 L142，SSE 读取在 L158。错误断言大多只看状态码或文本，只有 L736–740 用 `toMatchObject` 断言了 `MODEL_CONFIG_INCOMPLETE` 的 code。
- 实例层：`ohbaby-server/src/app/settings-read.integration.test.ts`（520 行）。
- OpenAPI 路径列表断言：`ohbaby-server/src/app/create-app.unit.test.ts` L1660–1669。

### 2.9 设置 improve-2 文档里的相关记录

- 02 L134：错误统一为 `{ ok: false, error: { code, message } }`，写接口成功时返回该分区的新读取结果。实现没有完全做到（见 §2.2）。
- 02 L116–126：key 不回显，`apiKey` 三态（不传保留、空串清除、给值替换）。
- 05 L101 把“错误码不统一”列为低优先级遗留：`MCP_SERVER_NOT_FOUND` 等没有 code，部分校验失败返回 500，全局 MCP 文件损坏时所有 PUT 都失败。

## 待核实

- 清除模型 key 时，`.env` 里的变量是否被删除。`patchEntry` 和 `persistDocument` 里没看到删除逻辑，设置 improve-2 02 L124 写的是“可移除”。核实方法：读 `ohbaby-agent/src/config/llm/writer.ts` 的持久化路径，或跑一次清除再看 `.env`。
- 实例层 `mcp/reconnect` 是否发布 `settings.changed`。路由里没有，`reconnectSettingsMcp` 内部没有读。本期 Web 不用 reconnect（D25），优先级低。
- 实例层旧接口 `/v1/model`、`search-api-key` 是否只通知本实例。依据只有设置 improve-2 02 L176，代码没有逐行核对。

## 推断

- Search 的 `FILE_NOT_FOUND`、`INVALID_JSON`、`LOAD_FAILED` 和 MCP 的文件访问错误，目前都会变成 500。依据：`handle` 只匹配 §2.2 表里的几个 code；设置 improve-2 05 L101 有同样记录。
- daemon 下缺目录头时返回 400 和小写 code `directory-required`（`ohbaby-server/src/runtime/workspace-scope.ts` L23–31），不符合 `isStableErrorCode` 的正则。依据：代码路径；测试 `settings-global.integration.test.ts` L262 只断言了 400。
