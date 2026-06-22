# ohbaby-web · Structured Slash Overlays

> `/connect`、`/connect-search`、`/compact` 的 v0.1.6 实施规格。它们在 UI 中仍由 slash 入口打开，但不进入 raw passthrough；浏览器提交结构化 REST 请求，daemon 再调用既有 `UiBackendClient` 能力。

---

## 1. Scope

本批做：

- slash palette 展示三类命令：
  - `executionKind:"passthrough"`：`/status`、`/help`、`/new`、`/mcps`、`/skills`，继续走 `POST /v1/commands`。
  - `executionKind:"overlay"`：`/connect`、`/connect-search`、`/compact`，只打开结构化表单。
- 后端新增结构化 REST：
  - `GET /v1/model`
  - `POST /v1/model/context-window-probe`
  - `POST /v1/model`
  - `POST /v1/settings/search-api-key`
  - `GET /v1/sessions/:id/context-window`
  - `POST /v1/sessions/:id/compact`
- `/connect` 保存模型配置后重置 runtime，与 CLI `connectModel` 语义一致。
- `/connect-search` 保存 Tavily key 后刷新 search config，与 CLI `setSearchApiKey` 语义一致。
- `/compact` 对当前 session 执行压缩，成功/失败以 overlay 结果呈现。

本批不做：

- 不把 `/connect`、`/connect-search`、`/compact` 加入 `WEB_PASSTHROUGH_COMMAND_IDS`。
- 不接 `POST /v1/interactions/:id`，也不开放 `parentBehavior:"interaction"` 命令。
- 不做 `/connect` provider 大量 preset、内置自动推荐或完整 provider marketplace。
- 不做 `/connect-search` 除 Tavily 以外的搜索 provider。

---

## 2. Web Command Palette Contract

`GET /v1/commands?surface=web` 返回 web palette catalog。catalog 仍从 daemon 的 command service 读取，再由 server 做二次选择：

- passthrough 命令使用 `ohbaby-sdk` 的 web-safe helper 过滤。
- overlay 命令只允许 `connect`、`connect-search`、`compact` 三个显式 id。
- 每个返回项包含：
  - `id`、`path`、`description`、`argumentMode`、`category`
  - `executionKind:"passthrough" | "overlay"`
  - `action:"executeCommand" | "connectModel" | "connectSearch" | "compactSession"`

`POST /v1/commands` 只接受 `executionKind:"passthrough"` 能覆盖的命令，继续拒绝 interaction 命令和未开放命令。overlay 只能通过结构化 REST 完成 mutation。

收到 `command.catalog.updated` 时，browser 清空 palette cache；下一次打开 slash 面板或执行 slash 命令重新请求 catalog。

---

## 3. `/connect` Overlay

字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 是 | 供应商标识，允许自由文本，默认空 |
| `baseUrl` | 是 | 模型 API base URL |
| `apiKeyEnv` | 是 | 后端读取的环境变量名 |
| `apiKey` | 否 | 一次性明文输入；空值表示后端从 env / `.env` 解析 |
| `model` | 是 | 模型 id |
| `contextWindowTokens` | 否 | 用户手动覆盖；若空，保存时按 CLI 探测规则决定 |
| `maxOutputTokens` | 否 | 最大输出 token，空则沿用后端默认 |

规则：

- UI 不暴露 `interfaceProvider`。server 根据 `baseUrl` 推断 OpenAI-compatible 还是 Anthropic metadata interface。
- `POST /v1/model/context-window-probe` 是只读探测：不写配置、不 reset runtime、不改变 active model。
- 探测成功返回 `source:"detected"`；探测失败且有用户手动 context 值时返回 `source:"user"`；探测失败且无用户值时返回 `source:"default"` 与 128k fallback warning。
- `POST /v1/model` 是权威保存：后端仍会重新解析 key 与探测/回退 context window，不能只信浏览器 probe 结果。
- 保存成功后清空 `apiKey` 输入；返回的 current model 不包含真实 key。

---

## 4. `/connect-search` Overlay

字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 是 | v0.1.6 固定为 `tavily` |
| `apiKeyEnv` | 是 | 默认 `TAVILY_API_KEY`，可编辑 |
| `apiKey` | 否 | 一次性明文输入；空值表示后端从 env / `.env` 解析 |

规则：

- 保存成功后清空 `apiKey` 输入。
- 结果只显示 provider、apiKeyEnv、configured 状态，不回显真实 key。
- 运行中保存仍由后端拒绝，UI 展示 409/错误文案并保留表单草稿。

---

## 5. `/compact` Overlay

打开时：

- 读取当前 active session。
- 调 `GET /v1/sessions/:id/context-window` 获取上下文窗口用量；若后端返回 `null`，显示“usage unavailable”，但仍允许用户提交。

提交：

- `POST /v1/sessions/:id/compact`，body 为 `{ force: boolean }`。
- `force` 默认 `true`，对齐 CLI `/compact` 默认行为。
- 成功结果展示 `status`、before/after token、saved token、pruned message count。
- 如果 `afterTokenCount >= beforeTokenCount` 或后端返回 warning，用非阻断 warning 样式提示。

---

## 6. Testing

确定性测试：

- SDK：web palette 类型与 helper 不把 overlay 加入 passthrough allowlist。
- server：`GET /v1/commands?surface=web` 同时返回 passthrough 与 overlay；`POST /v1/commands` 仍拒绝 overlay 命令。
- server：新增 REST 的 auth/client 校验、body 校验、错误映射、后端调用参数。
- agent：只读 context probe 不写配置、不 reset runtime，且沿用 CLI 的 128k fallback 规则。
- web client：请求路径、body、错误提示、catalog invalidation。
- UI：打开三个 overlay、提交成功、错误不丢草稿、敏感字段成功后清空、compact usage/result 展示。

E2E：

- deterministic：使用 fake backend / app.fetch / headless browser，验证 slash palette 打开 overlay、表单提交命中结构化 REST、UI 更新。
- real-link：启动真实 `ohbaby serve --web-assets-dir apps/ohbaby-web/dist`，使用项目 `.env` 中的 Zhipu `glm-4.7` 与 Tavily key，经浏览器执行 `/connect`、`/connect-search`，再发一个短 prompt 验证 daemon/backend/web 端到端链路。
