# 1. 前端代码现状

2026-10-24 调查。基于 `codex/redesign` 工作区（`c6d9be86` 加上未提交的 improve-3 改动）。路径相对 `apps/ohbaby-web/src/`，`packages/` 开头的路径相对仓库根。

## 已证实事实

### 1.1 设置页与 `/connect` 链路

- 没有设置页，`ui/settings/` 目录不存在。
- `ui/commands/ConnectOverlay.tsx` 共 469 行，导出 `ConnectModelOverlayBody`（L36）和 `ConnectSearchOverlayBody`（L399）。它调用 client 的 `getCurrentModel`（L85）、`probeModelContextWindow`（L142）、`connectModel`（L164）、`setSearchApiKey`（L419）。密钥输入框是 `type="password"`（L278、L443）。
- `ui/commands/StructuredCommandOverlay.tsx`（151 行）在 L96–99 挂载这两个组件。`structuredOverlayKindForAction`（L122–137）的 L129–132 把 `connectModel`、`connectSearch` 映射成 `"connect"`、`"connect-search"`。
- SDK `packages/ohbaby-sdk/src/slash-command/web-passthrough.ts`：`WEB_OVERLAY_COMMAND_IDS` 在 L18–23，action 类型在 L29–34，映射表在 L58–59、L77–78。和旧文档记录的位置一致。
- `ui/commands/slashCommands.ts`（453 行）的 L357–361 `isSetupOverlay` 只把这两个 action 归到 Setup 分类，不执行连接。
- `connectModel` 定义在 `packages/ohbaby-sdk/src/contract/client.ts:216`（`UiBackendClient`）。调用方有 TUI 的 `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx:165`，以及服务端 jsonrpc（`client.ts:532`、`rpc-route.ts:550`）和 `web/routes/model.ts:99`。

### 1.2 模型按钮与思考强度控件

- 模型按钮的文字来自 store 的 `snapshot.currentModel`（`ui/session/selectors.ts:171`，L303 兜底为 `model pending`）。数据由 `api/daemon/client-sync.ts` 的 `refreshModel`（L244）请求实例层 `GET /v1/model` 得到。
- `client-sync.ts` 收到 `model.invalidated` 后调用 `refreshModel`，然后直接 `return`（L601–604），**没有**调用 `notifyUiEvent`。其他事件（如 `session.resync-required`，L605–608）会调用。
- `ui/composer/ReasoningControl.tsx`（210 行）在 L71–98 自己调用 `client.getCurrentModel()`，并通过 `client.subscribeEvents` 等待 `model.invalidated`（L91）。`subscribeEvents`（`client-sync.ts:534`）只接收经 `notifyUiEvent`（L662）发出的事件。
- 唯一覆盖 ReasoningControl 刷新的测试是 `ui/App.unit.test.tsx:5576`，它直接调用 handler 触发事件，没有经过 `client-sync`。

### 1.3 设置相关的 HTTP 调用

- `api/daemon/http.ts`（651 行）只调用了 `GET /v1/model`（L511）、`POST /v1/model`（L524）、`/v1/model/context-window-probe`（L517）和 `POST /v1/settings/search-api-key`（L531）。没有调用任何 improve-2 设置接口。
- 不存在 `settings-client.ts`，也没有读取模型列表的代码。improve-2 第 3 步加过一个最小的 `GET /v1/settings/models` 客户端，第 6 步又删掉了，留给 improve-4（`../../improve-2/05-implementation-acceptance.md` L33，D3）。
- SDK `UiBackendClient` 里没有 settings 方法。

### 1.4 HTTP 传输与错误解析

- `request()` 的 `method` 已经支持 `DELETE | GET | PATCH | POST | PUT`（`http.ts:580`），但还没有调用用到 PUT。
- 错误类型 `DaemonRequestError`（L74–79）只有 `code?`、`status`、`targetDirectory?`，守卫函数是 `isDaemonRequestError`（L81）。`ErrorResponseBody`（L65–71）只读取 `error.message`、`code`、`targetDirectory`，在 L611–623 抛出。没有 `fields`。

### 1.5 SSE 事件

- Web 端没有专门处理 `settings.changed` 的代码，runtime 和 store 里都没有。
- `model.invalidated` 只在 `client-sync.ts:601` 处理（见 §1.2）。

### 1.6 路由与外壳

- 没有路由库。`bootstrap.ts` L23–28 从 `location.hash` 读 `directory` 和 `session`，L49 从 `?mock=` 读 mock 场景。`api/daemon/navigation-state.ts` 的 `replaceNavigationHash`（L88–104）用 `history.replaceState` 改写 hash。没有 `hashchange` 或 `popstate` 监听。
- `ui/shell/AppShell.tsx`（87 行）提供 `renderSidebar(close, dismissDrawer)`、`renderHeader`、`main`、`overlays`、`onSearch` 几个插槽。
- `ui/shell/AppController.tsx`（299 行）在 L191–297 组装插槽：有 client 时主区渲染 `SessionScreen`，否则渲染 `DraftFallback`（L258–274）；overlays 是 `NoticeStack` 和 `DirectoryPickerDialog`（L276–295）。
- `ui/sidebar/Sidebar.tsx`（432 行）分为 `.ohb-sidebar-top`（字标、折叠按钮）、`.ohb-sidebar-nav`（New chat、Search）和 `.ohb-sidebar-scroll`。左下角没有齿轮，侧栏也没有底部区域。

### 1.7 输入框控件

- `ComposerControls.tsx`（94 行）的 `.ohb-composer-bar` 从左到右是：权限控件（外部传入）、空白、模型按钮（`.ohb-model-button`，点击调用 `onOpenModel`）、`ReasoningControl`（原生 `<select>`）、发送或停止。
- 权限控件 `ui/permissions/PermissionPolicyControl.tsx` 是切换按钮，开启完全访问时弹出自带焦点循环的确认框（约 L54–100）。
- 窄屏适配全靠 CSS：`controls.css` 在 420px（L121）和 639px（L137）有断点，`composer.css` 在 720、480、420、639px 有断点（L686–736），`policy.css` 在 520、639px 有断点。`shared/viewport.ts` 的 `isPhoneViewport` 阈值是 639px，目前只有 `Menu` 在用。
- 输入框里只有 `ProjectPicker.tsx` 用了共享 `Menu`。模型按钮、ReasoningControl、权限控件都没用。`Menu` 在手机上显示为底部弹出（`Menu.tsx` L92、L262）。

### 1.8 没配模型时点发送

- `ui/session/SessionScreen.tsx`：L110–111 算出 `modelMissing = currentModelLoaded && currentModel === null`；L113–115 的 `openModelSetup` 调用 `openOverlayForSlashText("/connect")`；L117–126 的 `submit` 在 `modelMissing` 时打开 connect 浮层并返回 `false`；L252–253 让模型按钮显示 `Choose model`，点击也走 `openModelSetup`。
- `GET /v1/model` 读取失败时 `currentModelLoaded` 保持为假，不会被当成“没配模型”（improve-2 05 D3/B1）。

### 1.9 共享组件

- `ui/shared/` 现有 ContextUsage、ErrorBanner、IconButton、LycheeMark、MarkdownBlock、Menu（309 行）、Notice、Spinner、Wordmark、download-file、viewport 和 `shared.css`（349 行）。
- 没有 `ConfirmDialog`、`SettingsRow`、`SecretField`。相近的现有代码：`ui/commands/overlay-controls.tsx`（L8 输入框支持 `type="password"`）、PermissionPolicyControl 里的确认框、`ui/workspace/directory-picker/DirectoryPickerDialog.tsx`（L174，`aria-modal`）、`ui/commands/CommandResultModal.tsx`（L113）。

### 1.10 Mock 场景

- `dev/mock-scenarios.ts` 的 `mockScenarios`（L357 起）有 fresh、typical、many、search、running、approval、pending-move、no-model（L438）。没有 settings、settings-empty、settings-errors。`dev/mock-runtime.ts` 里也没有设置相关代码。

### 1.11 相关文件行数

| 文件 | 行数 |
|---|---|
| `ui/sidebar/Sidebar.tsx` | 432 |
| `ui/shell/AppController.tsx` | 299 |
| `ui/shell/AppShell.tsx` | 87 |
| `runtime/index.ts` | 731 |
| `api/daemon/http.ts` | 651 |
| `ui/commands/ConnectOverlay.tsx` | 469 |
| `ui/commands/StructuredCommandOverlay.tsx` | 151 |
| `ui/commands/slashCommands.ts` | 453 |
| `ui/composer/Composer.tsx` | 497 |
| `ui/composer/ReasoningControl.tsx` | 210 |

`ui/styles.css` 只有 19 行，是 `@import` 入口。实际样式按功能分散在各目录的 CSS 里，tokens 在 `ui/styles/tokens.css`（115 行）。

## 待核实

无。

## 推断

- **真实 daemon 下，ReasoningControl 收不到 `model.invalidated`，模型在别处切换后它不会自己刷新。** 依据：§1.2 的代码路径，`model.invalidated` 在调用 `notifyUiEvent` 之前就返回了，而 `subscribeEvents` 只接收经 `notifyUiEvent` 发出的事件。没有实际运行验证。
- `settings.changed` 带合法 seqNum 时，会经过 `dispatchUiEvent`（`client-sync.ts:673`）→ `store.applyEvent` → reducer 的兜底分支，原样返回 snapshot。依据：代码路径。
