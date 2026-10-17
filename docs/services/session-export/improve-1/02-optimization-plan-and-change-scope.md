# 2. 优化方案与改动面

> 本文是交给实施会话的执行契约。实施时按本文改代码，按 [04](./04-test-and-acceptance.md) 自测。
> 新模块内部的设计以 [../architecture.md](../architecture.md) 和 [../dfd-interface.md](../dfd-interface.md) 为准，本文不重复。

> 状态更新（2026-10-17）：后端批次之后，前端也已接入并完成本机端到端检查；最新结果与未覆盖边界见 [06](./06-frontend-acceptance.md)。下文保留原批次范围，作为实施顺序记录。

## 2.1 方案总览

新增一个只读的导出能力，**从下往上**接入：

```
 services/session-export        生成内容（HTML / JSONL），不写文件
          ▲
 ui-inprocess.exportSession     后端实现
          ▲
 SDK UiBackendClient.exportSession   ← 唯一契约
     ▲                         ▲
 RPC 代理 / JSON-RPC         REST GET /v1/sessions/:id/export
     ▲                         ▲
 TUI /export                 Web 菜单 Export ▸ HTML / JSONL
 写 ~/Downloads（本机）       Blob 下载（浏览器）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 内容在哪里生成 | 后端的 services 层 | 数据在后端，两端共用 | 前端拉取历史后自己拼 | 需要新增一个 SDK 方法 |
| 谁写文件 | 调用方（TUI 或浏览器） | 远程模式下文件也落在用户自己的机器上 | 后端命令直接写 Downloads | TUI 要自己实现保存 |
| TUI 命令怎么执行 | TUI 本地拦截后执行，后端只留占位实现 | 和 `/effort` 的模式一致 | 走后端命令，后端返回内容 | 新增一个"本地执行"分支 |
| 传输方式 | 返回 JSON `{filename, mimeType, content, messageCount}` | 复用现有的 JSON 请求和 RPC 机制，不新增二进制通道 | REST 直接流式返回文件，加 `Content-Disposition` | 内容会多一层 JSON 字符串转义，体积略大 |
| REST 鉴权 | 和 archive 一样：token、clientId、client 已注册 | 菜单可以导出非当前会话 | `sessionReadForClient`（只允许当前根会话） | 和 archive 一样，不校验工作区归属 |
| HTML 资源 | 生成成 TS 常量（复用 system-prompt 的做法） | 打包时不用拷贝资源 | 运行时 readFileSync（pi 的做法） | 多一个生成脚本，构建时要 check |
| 网页菜单 | 一项 Export，悬停或点击展开子菜单 | 用户已确认 | 直接放两项 | 要新写子菜单交互 |

## 2.3 分阶段实施

整个改造属于同一轮（improve-1），分 3 个 Stage。每个 Stage 做完都能单独验证。

**本批范围已确认**：Stage 1，加上 Stage 3 的 server JSON-RPC、REST 和 Web `http.ts` / `client.ts`。后者显式实现 SDK 接口，必须随新增方法一起接线才能保持全仓类型检查通过。Stage 2 与 Stage 3 的 runtime、下载工具、菜单和其他 UI 改动留给后续前端批次。本批不注册尚不能执行的 TUI `/export`。

### Stage 1：导出模块 + SDK 契约 + 后端实现

**目标**：在后端调用 `exportSession`，能拿到正确的 HTML 和 JSONL。

改动：
- **新增** `packages/ohbaby-agent/src/services/session-export/` 下的全部文件，结构见 architecture §三。
- **新增** `packages/ohbaby-agent/scripts/generate-session-export-assets.mjs`。
  - 输入 `html/template.{html,css,js}` 和 `marked/lib/marked.umd.js`，输出 `html/assets.generated.ts`。
  - 支持 `--check`。
- **修改** `packages/ohbaby-agent/package.json`：
  - devDependencies 加 `marked@^15`，和 web 保持一致。
  - scripts 加 `export-assets:generate` 和 `export-assets:check`。
  - 在 `build` 里，`prompt:check` 后面接上 `export-assets:check`。
- **修改** `packages/ohbaby-sdk/src/client.ts`：
  - 新增 `UiExportSessionInput { sessionId; format: "html" | "jsonl" }`。
  - 新增 `UiSessionExport { filename; mimeType; content; messageCount }`。
  - 在 `UiQueryClient` 里加 `exportSession(input): Promise<UiSessionExport>`。export 是只读操作，所以放在 Query，不放在 Command。
- **修改** `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`：
  - 实现 `exportSession`，注入 `options.sessionManager`、`messageManager` 和应用版本号。
  - 缺少 sessionManager 时，按 archive 的写法抛出 "not available"。
- **修改** `packages/ohbaby-agent/src/adapters/ui-persistent.ts`：加一个透传包装。

**DoD**：
- 模块的 unit 和 integration 测试全部通过（[../test.md](../test.md) 的 S1–S11、H1–H9）。
- `pnpm --filter ohbaby-agent build` 通过，`--check` 生效。

### Stage 2：TUI `/export`

**目标**：在 TUI 里执行 `/export`、`/export html`、`/export jsonl`，文件写入本机的 Downloads。

改动：
- **修改** `packages/ohbaby-agent/src/commands/catalog.ts`：新增 `export` 命令。
  - `surfaces: ["tui"]`、`argumentMode: "argv"`、`category: "session"`。
  - `acceptsArguments: true`，`argsHint: "[html|jsonl]"`。**不能漏掉 `acceptsArguments`**：没有它，解析器会拒绝带参数的写法（`ohbaby-sdk/src/slash-command/resolve.ts:122`），`/export jsonl` 就无法执行。
  - 描述写 "Export the current session to Downloads (HTML by default)"。
- **修改** `packages/ohbaby-agent/src/commands/builtin.ts`：
  - 新增 `export` 占位实现，返回 `INTERACTION_REQUIRED`，提示 "Use /export in the TUI"。写法同 `effort`。
  - 把 `export` 加进 `HELP_COMMAND_ORDER`。
- **新增** `packages/ohbaby-cli/src/tui/session-export/`：
  - `downloads-dir.ts`：`resolveDownloadsDir({ platform, env, homedir, readFile })`。规则见 [../dfd-interface.md §2.4](../dfd-interface.md)。依赖全部注入，方便测试。
  - `save-export.ts`：负责建目录、避开同名文件（加 `-1`、`-2`）、用 `wx` 写入，返回最终路径。
  - `run-export.ts`：解析参数（空参数导出 HTML），然后依次调 `client.exportSession`、调保存，返回保存路径和消息数。
- **修改** `packages/ohbaby-cli/src/tui/app.tsx`。**复用现有的 `executePromptCommand` 注入点**（`app.tsx:164`），不新增通用的 `onLocalCommand` 回调。
  - 这个函数现在已经在拦截 `compact`。照同样的方式加一个分支：`invocation.commandId === "export"` 时调用 `run-export`，不再转发给 `client.executeCommand`。
  - 返回值按 `CoreAPI["executeCommand"]` 的签名构造。
  - 当前会话 id 从已有的 `activeSessionIdRef` 读取。没有当前会话时，提示 "No session to export"。
  - `prompt/index.tsx` 的 `executeCommandInvocation` **不用改**。它会优先调用注入的 `executeCommand`，抛出的错误由现有的 `setError` 显示出来。
- **修改** `app.tsx` 的提示逻辑。现在的 `emitNotice` 定义在一个 effect 里面，而且级别写死为 `warning`（`app.tsx:453-467`），不能直接复用。
  - 把它提到组件作用域，改成接收 `level` 参数的 helper；或者为导出新增一个同样写法的 helper。
  - 导出成功：发 `info` 提示，内容是 `Exported N messages to <path>`，下面加一行敏感内容提醒。
  - 导出失败：发 `error` 提示，按错误码给出可读的说明。如果后端不支持导出，按 [../dfd-interface.md §3.2](../dfd-interface.md) 的规则提示 "not supported"。

**DoD**：04 中的 T1–T7 通过。macOS 上手工验证一次。

### Stage 3：server + Web

**目标**：网页端会话菜单 Export ▸ HTML / JSONL 可以下载文件。

改动：
- **修改** `packages/ohbaby-server/src/protocols/jsonrpc/`：
  - `protocol.ts`：`DAEMON_RPC_METHODS` 加 `"exportSession"`。
  - `rpc-route.ts`：`case "exportSession"` 先验证 client 已注册、输入对象与 sessionId，再调 `backend.exportSession`；RPC 没有统一强制注册检查，不能只新增透传分支。
  - `client.ts`：加 `exportSession`。
  - 这样 Stage 2 在远程模式下也能用。如果 Stage 2 先上线，这部分要和 Stage 2 一起做。
- **修改** `packages/ohbaby-sdk/src/rpc/proxy.ts`：确认新方法不需要登记 signal 参数（没有 signal 就不用改），并在 contract 测试里覆盖。
- **修改** `packages/ohbaby-server/src/app/create-app.ts`：
  - 新增 `GET /v1/sessions/:id/export`，校验顺序和 archive 一样。
  - `format` 只接受 `html` 或 `jsonl`，其他值返回 400。
  - 错误响应带上 `code`：`SESSION_NOT_FOUND` 返回 404，其余已知 code 返回 400。
  - 在 OpenAPI 描述里登记这个接口（同 archive，`create-app.ts:1020-1031` 附近）。
- **修改** `apps/ohbaby-web/src/api/daemon/http.ts` 和 `client.ts`：新增 `exportSession`。
- **修改** `apps/ohbaby-web/src/runtime.ts`：新增 `exportSession(sessionId, format)`。
- **新增** `apps/ohbaby-web/src/ui/shared/download-file.ts`：`downloadTextFile({ filename, mimeType, content })`。
  - 用 Blob 生成 object URL，交给一个临时 `<a download>` 点击，然后 `revokeObjectURL`。
- **修改** `apps/ohbaby-web/src/ui/session/SessionActionsMenu.tsx`：
  - 新增一项 `Export`，带 `Download` 图标、`aria-haspopup="menu"` 和右箭头标记。
  - 鼠标悬停或点击 Export 时，在右侧展开子菜单（`role="menu"`），里面是 `HTML` 和 `JSONL` 两项。
  - **子菜单渲染在主菜单的 DOM 里面**，不另外开 portal。这样现有的"点到菜单外就关闭"的检测（`SessionActionsMenu.tsx:45`）不会把点击子菜单误判为点了外面。
  - **主菜单和子菜单各自处理键盘**：
    - 主菜单：↑ ↓ Home End 只在 Pin、Archive、Export 之间移动。实现上要把现有的 `querySelectorAll("button")`（`:85-113`）改成只取主菜单自己的项。在 Export 上按 → 或 Enter，打开子菜单并聚焦 HTML。
    - 子菜单：↑ ↓ Home End 只在 HTML 和 JSONL 之间移动。按 ← 或 Esc 关闭子菜单，焦点回到 Export。Enter 执行导出。
    - **子菜单处理过的按键要 `stopPropagation` 和 `preventDefault`**，不能冒泡到主菜单。否则在子菜单里按 Esc 会把整个菜单关掉，按 ↑ ↓ 焦点会被拉回主菜单。
    - Esc 按两次：第一次关子菜单，第二次关主菜单，焦点回到触发菜单的按钮。
    - 子菜单里按 Tab，行为和主菜单一致，直接关闭整个菜单。
  - 鼠标：悬停在 Export 上展开子菜单，离开 Export 和子菜单之后收起。点击 Export 也能展开，方便触屏使用。
  - 子菜单的位置做视口裁剪：右侧放不下时，往左边展开。
  - 新增 prop `onExport(format)`。
- **修改** `SessionSidebar.tsx`：传入 `onExport`，执行时先关闭菜单，再调 `props.onExportSession(id, format)`。
- **修改** `SessionScreen.tsx`：实现 `exportSession`，内部调用 `runtime.exportSession` 和 `downloadTextFile`。失败时复用现有 `runAction` 的错误展示。

**DoD**：04 中的 W1–W8 通过。在 Chrome 和 Safari 上手工验证一次。

## 2.4 按包和目录的改动面

| 包 / 目录 | 新增 | 修改 | 说明 |
|---|---|---|---|
| `ohbaby-agent/src/services/session-export/` | 整个目录 | — | 导出模块 |
| `ohbaby-agent/scripts/` | `generate-session-export-assets.mjs` | — | 生成 HTML 资源 |
| `ohbaby-agent/package.json` | — | 加 devDependency 和 scripts | — |
| `ohbaby-agent/src/adapters/` | — | `ui-inprocess.ts`、`ui-persistent.ts` | 后端实现 |
| `ohbaby-agent/src/commands/` | — | `catalog.ts`、`builtin.ts` | 新命令和占位实现 |
| `ohbaby-sdk/src/` | — | `client.ts`、`rpc/proxy.ts`（如需要） | 契约 |
| `ohbaby-server/src/protocols/jsonrpc/` | — | `protocol.ts`、`rpc-route.ts`、`client.ts` | 远程 RPC |
| `ohbaby-server/src/app/` | — | `create-app.ts` | REST |
| `ohbaby-cli/src/tui/session-export/` | 3 个文件 | — | Downloads 目录和保存 |
| `ohbaby-cli/src/tui/` | — | `app.tsx`（`executePromptCommand` 分支、notice helper） | 本地执行 |
| `apps/ohbaby-web/src/` | `ui/shared/download-file.ts` | `api/daemon/http.ts`、`api/daemon/client.ts`、`runtime.ts`、`ui/session/SessionActionsMenu.tsx`、`SessionSidebar.tsx`、`SessionScreen.tsx`、相关 CSS | 菜单和下载 |
| `docs/commands/architecture.md` | — | 补一段"TUI 本地执行命令" | 权威文档同步 |

## 2.5 API、协议与兼容

- **SDK 新增方法**：老的后端实现没有这个方法。
  - **不能用** `typeof client.exportSession === "function"` 判断，因为 RPC 代理对任何方法名都会返回一个函数（`ohbaby-sdk/src/rpc/proxy.ts:232`），远程 host 也会再包一层（`ohbaby-cli/src/bin.ts:646`）。
  - 调用方直接调用，按错误判断后端是否支持：JSON-RPC 返回未知方法、REST 返回 404 且没有 code、本机后端抛出 not available。这三种情况统一提示 "Export is not supported by this backend"，详见 [../dfd-interface.md §3.2](../dfd-interface.md)。
  - 不额外做能力协商。
- **JSON-RPC**：新方法名加进白名单。老的 daemon 收到不认识的方法会报错，这个错误按上面的规则映射成 not supported。
- **旧 daemon 的命令目录里没有 `export`**：TUI 输入 `/export` 时，走现有的"未知命令"提示。这是可以接受的。
- **REST**：新路由，对现有接口没有影响。
- **JSONL 格式**：v1 发布后，规则按 [../data-model.md §3.4](../data-model.md)。
- **数据库**：不需要迁移。

## 2.6 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| HTML 里出现 XSS | 用户打开导出文件时执行恶意脚本 | 禁用原始 HTML、过滤 URL、加 CSP。在 jsdom 里真正执行页面脚本来测 |
| 导出泄露 model-state 等内部数据 | 加密思考内容、接口地址出现在文件里 | 用 S3 哨兵测试守住；JSONL 解析后检查，HTML 解码嵌入数据后检查，不对 base64 产物直接 grep |
| 大会话导出慢或占内存 | MCP 输出、图片、长历史都会让会话变大。工具执行时的截断并不能限制整段历史的长度，经过 RPC 还要再复制一份 JSON | 本轮接受这个代价，不设上限。但验收时必须实测：用一个包含大图片的长会话测耗时和内存，见 04 §4.5。结果不能接受时，再考虑流式输出 |
| Linux 的 `user-dirs.dirs` 写法比较特殊 | 解析不出来时落到 `~/Downloads` | 规则见 dfd §2.4，有回退，并且有单测覆盖异常情况 |
| Windows 下载文件夹被用户挪走了 | 文件仍然写到 `%USERPROFILE%\Downloads` | 作为已知限制写进文档，本轮不查询 Known Folder |
| 子菜单的键盘交互回归 | 主菜单导航出问题，Esc 一次就把整个菜单关掉 | 两级菜单各自处理键盘，并阻止事件冒泡。W5、W6、W9、W10 用例覆盖 |
| MCP 图片渲染引入 XSS | 有人构造恶意的 data URI | 只放行 png、jpeg、gif、webp 四种位图，base64 段要严格匹配，SVG 一律拒绝。H7、H8 用例覆盖 |

**回滚**：全部改动都是新增。回滚就是撤掉命令目录里的 `export`、Web 菜单项和路由，模块本身可以保留。

## 2.7 与 00 的边界对齐

| 00 中的决策 | 本文对应位置 |
|---|---|
| #1、#2 | Stage 1 的两个渲染器，Stage 2 的参数解析 |
| #3、#4 | Stage 2 的 `downloads-dir.ts`，Stage 3 的 Blob 下载 |
| #5 | 不解析路径参数 |
| #6 | 不做导入 |
| #7、#8、#9 | 模块 data-model |
| #10 | architecture §四 |
| #11 | Stage 3 的子菜单 |
| #12 | catalog 的 `surfaces: ["tui"]`，不加进 web passthrough |

## 2.8 不在本轮

- 再导入、导出 Markdown、调试 ZIP、分享链接。
- 导出子代理的中间过程。
- 自定义导出路径。
- 在网页输入框里用 `/export`，以及在 headless、stdout 模式下导出。
- 内容脱敏。
- 代码高亮、跟随 TUI 主题的配色。
- 流式导出、大小上限。
