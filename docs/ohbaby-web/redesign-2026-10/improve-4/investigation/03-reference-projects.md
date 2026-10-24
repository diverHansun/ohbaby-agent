# 3. 参考项目的设置页做法

2026-10-24 调查。项目都在 `/Users/hansun025/Projects/code-cli/` 下，下文路径相对各项目根目录。只记录各项目怎么做，不做评价。

## 已证实事实

### 3.1 pi-web（`frontend/pi-web`，Next.js）

`pi/` 仓库只有 TUI，Web 版在 `frontend/pi-web`。

- **布局**：设置是全屏蒙层的模态框，不是路由页（`components/SettingsPanel.tsx` L505–634，`role="dialog"`、`aria-modal`）。顶部是一排横向 tab（`settings-section-tabs`，L597），分区为 general、models、skills、agents、plugins、mcp。窄屏（640px 以下）tab 换成原生 `<select>`（`app/settings.css` L1457、L1540、L2006）。看过的分区一直挂载，只用 `hidden` 隐藏。需要项目的分区在没有 cwd 时禁用。
- **Models**：`components/ModelsConfig.tsx`（2333 行），读写整份 `models.json`（`app/api/models-config/route.ts`，GET/PUT）。
- **密钥输入有两种**：
  - 自定义 provider 用 `SecretTextInput`，默认掩码，可以切换明文。值来自 `models.json` 的 `provider.apiKey`，也就是 GET 会把明文发到浏览器（`ModelsConfig.tsx` L220–260、L433）。
  - 内置 provider 走“只替换”：输入框始终为空，已配置时 placeholder 写 `Enter new key to replace…`，提交到 `POST /api/auth/api-key/:provider`，成功后清空，另有 remove（`ModelsConfig.tsx` L1588–1700）。
- **MCP 密钥**：env、header 的值不发给前端，只发名字；URL 和参数里像凭据的部分显示为 `•••`，掩码只用于显示（`lib/mcp-secrets.ts`）。
- **输入框的模型选择只对当前会话生效**（注释写明 session-scoped, as in the TUI）。每一行有星标，点星标才调用 `PUT /api/models/default` 设为新会话的默认模型（`components/ModelSelector.tsx` L32、L183、L350，`components/ChatInput.tsx` L2462–2474，`app/api/models/default/route.ts`）。
- **MCP 不是只读**：可以开关单个或整组 server、Test、OAuth 登录、添加和导入（`components/McpConfig.tsx`、`McpAddServer.tsx`、`McpSignIn.tsx`）。
- **MCP 状态来源**：`GET /api/mcp` 只读文件，不发起连接。状态来自 Test 结果或已打开会话的上报，按“文件 + 名称 + 配置内容 HMAC”记录，配置一改就显示 untested（`lib/mcp-status.ts` 头部注释，ADR 0006）。
- **错误返回**：models-config 只返回 `{ error: string }`，没有字段路径。MCP 的拒绝有结构：`McpErrorResponse { error, reason, path, name, suggestedName, notes[], names[] }`，其中 `path` 是文件路径（`lib/api-types.ts` L664）。
- **手机输入框的“更多”**：`isMobile` 时显示 `moreControls` 按钮（`aria-expanded`），点开才显示思考强度、工具预设、compact 等控件；**模型选择器始终可见**，不收进去。切回桌面时自动关闭菜单。流式输出时，steer/follow-up 按钮移到草稿下方单独一行（`components/ChatInput.tsx` L354–360、L1722、L2490–2600、L2844）。

### 3.2 opencode（`opencode/packages/app`，SolidJS，Web 和桌面共用）

- **布局**：独立路由 `/settings`，整页，懒加载（`shell/routes/routes.tsx` L20、L47，`settings/shell.tsx`）。左侧是分组导航，带搜索（`settings/navigation.tsx`、`search*.ts`）。分区有 general、appearance、notifications、shortcuts、projects、workspaces、providers、models、extensions、servers、experimental、about；extensions 下再分 mcps、plugins、skills、lsps 子 tab（`settings/pages.ts`、`route.ts`）。
- **Models**：按 provider 列出模型，每个模型和 provider 都有开关，控制它在选择器里是否出现（`settings/models/models.tsx` L72–94）。
- **密钥**：在 connect 弹窗里用普通 `TextInput`（`autocomplete=off`，没看到 password 类型），提交到 `integration.connect.key`（`providers/connect/dialog.tsx` L1000–1060）。凭据存在 core 的数据库里（`core/src/credential.ts`，有迁移把旧 `auth.json` 导入）。
- **自定义 provider 表单**：前端逐字段校验，错误按字段存放（`providers/credentials/form.ts`）；保存逻辑目前直接抛出 unavailable，等 V2 的配置接口。
- **输入框的模型选择**：写入会话或草稿，同时更新最近使用列表。没有配置时依次退回到：配置里的模型 → 最近用过的 → 第一个已连接 provider 的第一个模型（`providers/models/selection.tsx` L170–200、L416–433）。
- **MCP**：状态有 connected、failed、needs_auth、disabled、pending，failed 时带错误文本（`schema/src/mcp.ts` L78–81）。界面有开关，按状态分派到连接、断开、认证（`runtime/server/global-sync/mcp.ts`，`settings/workspaces/project-extensions.tsx` L290–306）。不是只读。
- **结构化配置错误**：前端能解析 `ConfigInvalidError { data: { path, message, issues: [{ message, path: string[] }] } }`，每条渲染成 `a.b.c: msg`（`app/src/runtime/server/errors.ts` L1–8、L99–120）。

### 3.3 ZCode（`ZCode/packages/ui`，桌面和 Web）

- 设置是整页 `SettingsPage`，有侧栏和返回按钮（`SettingsPage.tsx` L701）。
- MCP 状态快照：`{ status, transport, toolCount, updatedAt, error?, failureKind? }`（`packages/shared/src/zcode-protocol/index.ts` L781–821）。`failureKind` 分 config_invalid、runtime_unavailable、process_start_failed、network_unreachable 等八类，映射成文案和可展开的技术详情（`settings/McpFailurePresentation.tsx`）。
- MCP 列表显示 toolCount 和开关（`settings/McpServerList.tsx` L109–161），状态点叠在图标角上（`McpSettingsSection.tsx` L485–506）。
- 密钥输入是 password 类型，可以切换明文（`settings/model-provider-section/ApiKeyInput.tsx` L35）。
- 校验错误：`formatZodError` 把 issues 拼成 `path.join(".") + ": " + message`，多条用 `; ` 连成一个字符串（`packages/shared/src/validation.ts` L66–73）。

### 3.4 deepseek-harness（`apps/web` 加 `packages/client/ui-settings-*`）

- 设置是 760×500 的模态面板，左侧导航（`ui-settings-general/src/client/SettingsRoot.tsx` L3、L70–89）。有独立的 ui-settings-models、ui-settings-web-search、ui-secret-mask 包。没有 MCP 状态界面。
- 写入按路径操作：`{ op: 'set' | 'unset', path: string[], value }`，带 `expectedRevision` 乐观锁（`packages/settings/settings/src/types.ts`）。请求不合法时返回 `gateway/bad-request` 和 zod issues；版本冲突返回 `settings/conflict`；其他拒绝只有 message（`packages/api/settings-controller/src/index.ts` L186–268）。
- 密钥：读取时按结构脱敏，响应带 `secrets: [{ path, set: boolean }]`，前端据此画只写输入框；已有 key 时 placeholder 是“留空使用已保存凭据”（`packages/settings/settings/src/redact.ts`，`ui-settings-models/src/client/ApiKeyInput.tsx`、`ProviderEditor.tsx` L242）。

### 3.5 其他项目

- codex：只有 app-server 协议类型 `McpServerStatus { runtimeStatus, tools, serverInfo, httpOrigin, authStatus… }`，`httpOrigin` 去掉了凭据和路径，没有 Web 界面（`codex-rs/app-server-protocol/schema/typescript/v2/McpServerStatus.ts`）。
- kimi-code：VS Code webview 里有 `MCPServersModal.tsx`（595 行，模态框）。
- claude-code：只有 TUI 的 MCP 对话框。
- pi（`packages/coding-agent`）、minimax-code、Step-Code：没有 Web 设置界面。

## 待核实

- opencode 的 `ConfigInvalidError` 在当前 core 或 server 源码里没找到产生的地方，可能是 V1 遗留，或者在别的包里。
- kimi-code 的 MCP 状态展示细节没有细看。
- opencode、deepseek-harness、ZCode 的输入框有没有类似“更多”的收纳：只做了关键词搜索，没找到。

## 推断

- opencode 的输入框模型选择器不写全局默认。依据：`selection.tsx` 只写会话和草稿状态。
- ZCode 的模型 key 明文会发到前端。依据：输入框支持切换明文显示，但没有追读接口。
