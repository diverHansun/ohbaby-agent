# improve-4 · 1. 现状

> 2026-10-24 按 `codex/redesign` 工作区（`c6d9be86` 加上未提交的 improve-3）重新核对，原来基于 `f5f36b9e`。逐条证据和待核实项见 [开工前调查](investigation/README.md)。路径相对 `apps/ohbaby-web/src/`，后端路径相对 `packages/`。

## 前端

- 没有设置页，也没有 `ui/settings/`。模型和搜索 key 通过 `ui/commands/ConnectOverlay.tsx`（469 行）修改，由 `ui/commands/StructuredCommandOverlay.tsx`（L96–99）挂载。`/connect`、`/connect-search` 的 `connectModel`、`connectSearch` action 定义在 SDK `packages/ohbaby-sdk/src/slash-command/web-passthrough.ts`（L18–34、L58–78），`ui/commands/slashCommands.ts`（L357–361）只做分类。`connectModel` 也是 SDK `UiBackendClient` 的方法，TUI 的 `connect-panel.tsx:165` 在用。
- 没配模型时点发送：`ui/session/SessionScreen.tsx` L110–126 打开 `/connect` 浮层；模型按钮显示 `Choose model`。
- 模型按钮读 store 的 `currentModel`，来自实例层 `/v1/model`。`ui/composer/ReasoningControl.tsx` 自己读 `/v1/model` 并订阅 `model.invalidated`，但 `api/daemon/client-sync.ts` L601–604 处理这个事件后直接返回，没有转发给订阅者（推断它收不到，未实际运行验证）。
- `api/daemon/http.ts`（651 行）只调用了 `/v1/model` 系列和 `/v1/settings/search-api-key`，没有 improve-2 设置接口的调用，也没有 `settings-client.ts`（improve-2 加过又删了，留给本批）。传输层已经支持 PUT、PATCH、DELETE；错误类型 `DaemonRequestError` 只有 `code`、`status`、`targetDirectory`，没有 `fields`。
- Web 端没有处理 `settings.changed` 的代码。
- 没有路由库，hash 只用于 `directory` 和 `session`，用 `replaceState` 改写，没有 `popstate`/`hashchange` 监听。侧栏（`ui/sidebar/Sidebar.tsx`，432 行）左下角没有齿轮，也没有底部区域。
- 输入框控制行（`ui/composer/ComposerControls.tsx`）：权限控件、模型按钮、ReasoningControl（原生 `<select>`）、发送/停止，都没用共享 `Menu`；窄屏适配全靠 CSS（420px、639px 等断点）。
- `ui/shared/` 没有 `ConfirmDialog`、`SettingsRow`、`SecretField`。mock 场景只有 `no-model`，没有 `settings` 系列。
- 当前没有 MCP 配置前端，用户通过对话让 ohbaby 修改配置文件；加载的 MCP 工具直接注入 agent 工具列表。本批按 D25 增加只读的配置与状态展示。

## 后端（设置议题 improve-2 已完成）

- 全局层（`ohbaby-server/src/protocols/web/routes/global-settings.ts`）：`GET /v1/settings/models`；`POST models/profiles`；**`PATCH`** `models/profiles/:id`；`POST models/active`、`models/probe`；`DELETE models/profiles/:id`、`models/providers/:providerId`；`GET about`；`GET`/`PUT search`；`GET mcp/servers`；`PUT`/`DELETE mcp/servers/:name`。
- 实例层（`routes/settings.ts`）：`POST mcp/reconnect`；`GET mcp/status`、`skills`、`agents`。类型在 `ohbaby-sdk/src/contract/settings.ts`。
- 缺口（D19）：`global-settings.ts` L50–93 的 `handle` 里，`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE` 已带 code；`VALIDATION_FAILED` 和 ZodError 只返回 `Invalid settings`，没有 code 和字段；`MCP_SERVER_NOT_FOUND` 的 code 被丢掉。agent 侧的 Search、MCP 校验错误已经带 issues，只是没传出去。鉴权、非法 JSON、超大请求、服务不可用都没有 code。SDK 里没有通用错误类型。
- 写入后 `settings.changed` 广播给所有已加载的实例；domains 含 model 时还发 `model.invalidated`。
- 已知接口限制：读取从不返回 key，只返回 `apiKeyEnv` 和 `apiKeyConfigured`；`baseUrl` 和 MCP 地址读回是脱敏的；模型可选字段不存在时省略，只有 `label` 能用 null 清除；清除 key 与无 key 模式相同（见 [06 §2.2](../06-data-api-and-state.md)）。
