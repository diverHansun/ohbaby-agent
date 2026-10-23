# improve-2 · 1. 现状

> 代码基线 `codex/redesign`（`f5f36b9e`），假设 improve-1 已完成。路径相对 `apps/ohbaby-web/src/`。

## 运行时围着“当前目录”转

- `runtime.ts`（625 行）的 `OhbabyWebRuntime` 持有一个 `client` 和一份 `WorkspaceSnapshot`（`scopes` + `selectedDirectory`），对外是 `switchWorkspace`、`openWorkspace`、`createSession`、`selectSession` 等。切目录就重建 client 和 SSE。
- `createSession()` 点击“新对话”就在当前目录创建服务端会话，没有本地草稿阶段。
- 浏览器导航状态 `api/daemon/navigation-state.ts`（`ohbaby.web.navigation.v1`）记 `selectedDirectory` 和每个目录最近的会话。

## 客户端

- `api/daemon/client.ts`（1447 行）是一个 `BrowserDaemonClient` 类，实现整个 `UiBackendClient`：连接与 SSE 同步、历史分页、提交与插话、命令、模型与搜索 key、权限、子代理，全在一个类里。
- `api/daemon/http.ts`（627 行）只有 scopes、目录选择和实例接口，没有 `GET /v1/sessions`、`/v1/sessions/search`、`POST /v1/sessions/:id/project`。SDK 只有这些接口的类型（`ohbaby-sdk/src/contract/global-sessions.ts`），没有 HTTP 客户端。
- 后端没有处理过 `SESSION_MOVED` 的客户端代码。

## 本地状态的 key 都带目录

- 草稿：`ui/session/SessionScreen.tsx` 的 `draftScopeKey` 是 `<selectedDirectory>:<sessionId|new>`，换项目就读不到原文字。它同时用来生成插话租约的 `composerLeaseKey`，也是输入框重新挂载的 `key`（约 L1263）；改 key 会连带租约和重挂载行为（improve-1 拆分后这些逻辑在 `useComposerDraft.ts`）。
- 置顶：`ui/session/session-pins.ts` 的 `sessionPinsKey` 按 origin + 目录分 key。

## 相关测试

目录切换相关的集成测试较多，例如 `api/daemon/workspace-switch.integration.test.ts`、`session-restore.integration.test.ts`、`new-session-regression.integration.test.ts`，改运行时会连带它们。
