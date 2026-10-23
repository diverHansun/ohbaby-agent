# improve-4 · 1. 现状

> 前置目标：improve-1、improve-2 完成后已有 `Menu`、草稿状态和最小模型列表读取能力；运行时能给出“设置目录”（当前会话的请求目录、草稿所选项目或默认工作区，06 §3.7）。以下未特别说明的代码事实仍以 `f5f36b9e` 为基线，开工时复核。路径相对 `apps/ohbaby-web/src/`，后端路径相对 `packages/`。

## 前端

- 没有设置页。模型和搜索 key 通过 `ui/commands/ConnectOverlay.tsx`（469 行）修改，由 `ui/commands/StructuredCommandOverlay.tsx`（约 L129）挂载。`/connect`、`/connect-search` 的 `connectModel`、`connectSearch` action 定义在 SDK `packages/ohbaby-sdk/src/slash-command/web-passthrough.ts`（约 L19–79），`ui/commands/slashCommands.ts`（L361）只做分发。`connectModel` 也是 SDK `UiBackendClient` 的方法，TUI 在用。
- 模型按钮和 `ui/composer/ReasoningControl.tsx` 读的是实例层的 `/v1/model`，监听 `model.invalidated` 刷新。
- `api/daemon/http.ts` 只调用了 `/v1/settings/search-api-key`，没有任何 improve-2 设置接口的调用。

## 后端（improve-2 设置议题已完成）

- 全局层 `/v1/settings/models`、`search`、`mcp/servers`、`about`，实例层 `/v1/settings/mcp/status`、`mcp/reconnect`、`skills`、`agents` 都已可用，类型在 `ohbaby-sdk/src/contract/settings.ts`。
- 缺口（D19）：`ohbaby-server/src/protocols/web/routes/global-settings.ts` 的校验失败只返回 `Invalid settings`，没有错误码和出错字段；`MCP_SERVER_NOT_FOUND` 等错误不带 `code`；MCP 服务器名不合法时返回 500。
- 已知接口限制：部分字段无法清空，MCP 地址读回是脱敏的，清除 key 与无 key 模式相同（见 [06 §2.2](../06-data-api-and-state.md)）。
