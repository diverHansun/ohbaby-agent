# improve-4 · 2. 方案与改动面：设置页

> 依据：[01 §2.9、UC-SETTINGS-01 至 05](../01-use-cases-and-user-flows.md)、[03 §4.7](../03-ui-layout-and-style.md)、[04 §2.6](../04-interaction-and-states.md)、[05](../05-components.md)、[06 §1.3、§2.2、§3.7](../06-data-api-and-state.md)，决策 D2、D12–D20、D25、D29。现状见 [01](01-current-state.md)，验收见 [04](04-test-and-acceptance.md)。

## 目标

设置弹窗：Models、MCP、Skills、Web search、About 五个分区。MCP 只展示配置和状态，配置修改继续交给 ohbaby；输入框的模型按钮直接选择全局默认模型；Web 端删掉 `/connect` 浮层。

## 批次（2026-10-24 确认）

这一批的量太大，拆成 4a、4b 两批，**先后进行**：4b 的每一项都要用到 4a 的设置客户端、模型缓存和弹窗骨架，并行只会互相等待或重复造轮子。每批独立可运行、可验收，验收项按批次标注在 [04](04-test-and-acceptance.md)。

| 批次 | 范围（下文编号） | 做完后 |
|---|---|---|
| **4a** | Stage A；Stage B 的 1、2、3、5a、7、8 | 弹窗里能管理模型和 Web search；`/connect`、`/connect-search` 两个旧浮层一次删干净；事件刷新与 `model.invalidated` 修复到位 |
| **4b** | Stage B 的 4、5b、6 | MCP、Skills、About 三个只读分区；输入框 `ModelMenu`；手机“更多” |

- Web search 放进 4a，是因为删除 `/connect-search` 后它是唯一的搜索 key 入口；旧浮层不留半截。
- 4a 的弹窗导航只显示已实现的 Models、Web search；4b 再补上 MCP、Skills、About，不显示占位分区。
- 4a 期间输入框模型按钮的行为是：有模型时仍显示模型名，点击打开设置弹窗的 Models；没有模型时点发送也打开 Models。4b 换成 `ModelMenu`。
- 4a 内部，Stage A（后端）和前端骨架可以同时开工，Models 表单对接字段错误前要等 Stage A 完成。

## 范围

**Stage A · 后端前置（D19，4a）**：

2026-10-24 确认：只把后端已有的校验信息安全地传出来，不统一整个 daemon 的错误格式。agent 侧的校验错误已经带 issues，只是 `global-settings.ts` 的 `handle`（L50–93）把它们丢了（[调查 02 §2.2](investigation/02-backend-settings-api.md)）。

- **改 `handle` 一个函数**：`VALIDATION_FAILED` 和 ZodError 返回 `{ ok: false, error: { code: "VALIDATION_FAILED", message, fields: [{ path, message }] } }`。`path` 用字段路径数组（如 `["defaults", "timeout"]`）。
- **`fields[].message` 由后端按 issue 类型生成固定文案**（如“必须是 http 或 https 地址”“必须是正整数”）。不直接用 zod 3 的默认提示，因为部分提示会带出输入值（如枚举错误的 `received '…'`），违反 D9。也不序列化原始 issue、请求值或含凭据的 URL。
- **同文件顺手补齐**：`global-settings.ts` 里所有错误响应都带 code。`MCP_SERVER_NOT_FOUND` 补回 code；`webErrorBody` 加可选 code 参数，鉴权失败（`handle` 内）、非法 JSON 和请求体过大（在 6 个路由体里各自返回，L109–113、129、150、172、240、267）、兜底 500 各带一个固定 code。`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE` 已有，保持不变。实例层 `routes/settings.ts`（`Settings reads are unavailable` 等 503 在这里）本批不改：4a 不调用实例层设置接口，4b 只读，前端按通用失败显示。
- **SDK**：`contract/settings.ts` 增加 `UiSettingsError` 类型，列出上述 code；在设置议题的 improve-2 文档里登记这次补充。
- **不做**：不改 daemon 全局错误（如缺目录头的 `directory-required`），设置页走全局接口碰不到；不改 MCP 写入、名称校验和重连的错误；Search、MCP 读文件失败仍是 500，前端按“保存失败 + 原因”显示。

**Stage B · 前端**（每项所属批次见上方“批次”表）：

1. **设置客户端**：`api/daemon/settings-client.ts`，扩展 improve-2 的最小模型读取能力；全局请求不带目录头，实例请求带“设置目录”（06 §3.7）。只依赖 SDK 类型。共用传输已支持 PUT、PATCH、DELETE（模型修改用 PATCH），只需给 `DaemonRequestError` 加上 `fields`。
2. **弹窗骨架**（2026-10-24 改，D2）：`ui/settings/SettingsDialog.tsx` 是居中的模态弹窗，左侧 `SettingsNav`，右侧分区内容；分区和编辑子页用内存状态切换，不进 URL，不加 `popstate` 监听。侧栏左下角加齿轮入口。关闭时弹窗保持挂载、只隐藏，本次页面内再打开原样恢复（分区、编辑子页和输入都在）；切到其他分区时丢弃当前编辑子页的输入；刷新页面全部清空。手机全屏。
3. **Models**：`ModelsSection`（按 provider 分组、行菜单、provider 组菜单、删除确认 D17）、`ModelEditor`（常用字段加 More options，只提交改过的字段，`SecretField`）、D20 自动设为默认、从草稿跳来时回草稿。
4. **MCP**：`McpSection`（全局配置列表合并实例状态）、`McpDetails`（原地展开只读配置、失败原因和工具列表）。只接两个 GET；Refresh 重新读取，不触发重连。没有表单、启停开关、添加或删除入口，配置修改继续交给 ohbaby（D25）。
5. **其余分区**：
   - 5a（4a）**Web search**：一页表单，只提交改过的字段，key 用 `SecretField`。
   - 5b（4b）**Skills、About**：各一个只读小组件。
6. **输入框模型菜单与手机控制行**（D29）：`ui/composer/ModelMenu.tsx`，读全局模型列表，选中调用 `POST /v1/settings/models/active`；`ReasoningControl` 在模型变化后刷新。同时完成从 improve-1 移入的手机“更多”（2026-10-24 确认，照 pi-web）：< 640px 时，控制行只露出“更多”、模型按钮和发送/停止，权限模式和思考强度收进“更多”。“更多”复用共享 `Menu`，手机上是底部面板，里面有两行。点 `Thinking: <当前值> ›` 时，菜单在原地换成选项列表，选完回到一级。`Full access` 是开关，打开时沿用现有的“Enable full access?”确认框。桌面不变，思考强度仍用原生 `<select>`，不改成 Menu。只按 640px 一个断点切换，不新增一套控制状态，保持草稿与焦点。
7. **删除旧入口**（D18）：删除 `ConnectOverlay` 及 `StructuredCommandOverlay` 中的挂载；SDK `web-passthrough.ts` 不再向 Web 暴露 `connectModel`、`connectSearch` 两个 action（TUI 的命令路径保持不变）；`UiBackendClient.connectModel` 保留给 TUI。没配模型时点发送改为打开设置 › Models。
8. **刷新**：写接口返回值替换缓存；`settings.changed`、进入分区、窗口重新激活时重新读取（06 §3.7）。`api/daemon/client-sync.ts` L601–604 处理 `model.invalidated` 后直接返回、没有转发给订阅者，导致 `ReasoningControl` 收不到（[调查 01 §1.2](investigation/01-frontend-code.md)）；本批一并修正，并补一个经过 `client-sync` 的测试，`settings.changed` 同样要转发。

保留 `GET /v1/model` 及现有 `model.invalidated` 对实例状态和 ReasoningControl 的刷新；只移除旧配置写入口。设置缓存按 domain 和实例目录划分，独立文件组织；请求 generation 防止旧 GET 覆盖新写结果。表单字段清空按 06 §2.2 执行，不能把用户改动静默丢弃。

不做：Agents 分区、项目级配置、MCP 配置写入/启停/重连/OAuth、推理能力展示与手动探测、`/v1/model` 等旧接口下线（00 Non-goals）。现有 MCP 写入与重连服务端接口保留。

## 改动面

| 位置 | 新增 | 修改 | 删除 |
|---|---|---|---|
| `ohbaby-server/src/protocols/web/routes/global-settings.ts`、`request-helpers.ts` | — | `handle` 输出 `VALIDATION_FAILED` 和 fields；所有错误带 code；`webErrorBody` 加可选 code | — |
| `ohbaby-sdk/src/contract/settings.ts` | 错误类型 | — | — |
| `api/daemon/` | — | 新增 `settings-client.ts`；`http.ts` 的 `DaemonRequestError` 增加 fields，去掉旧配置写调用（`setSearchApiKey` 等）；`client-sync.ts` 转发 `model.invalidated` 和 `settings.changed` | — |
| `store/` | 按 domain 组织的设置缓存与选择器 | 统一入口接线 | — |
| `ui/settings/` | `SettingsDialog`、`SettingsNav`、各分区、模型编辑子页、`SecretField`；`mcp/` 内为只读列表与详情 | — | — |
| `ui/shared/` | `SettingsRow`、`ConfirmDialog` | — | — |
| `ohbaby-sdk/src/slash-command/web-passthrough.ts` | — | Web 端不再提供 connect 两个 action | — |
| `ui/sidebar/`、`ui/shell/` | — | 4a：`Sidebar` 加底部区域和齿轮；`AppController` 挂载 `SettingsDialog` | — |
| `ui/session/` | — | 4a：`SessionScreen` 的 `openModelSetup`（L113–115、L252–253）从 `/connect` 改为打开设置 › Models | — |
| `ui/composer/` | 4b：`ModelMenu.tsx`、`ComposerMoreMenu.tsx` | 4b：`ComposerControls`；4a：`ReasoningControl` 随事件修正验证刷新 | — |
| `dev/` | — | `mock-scenarios.ts`、`mock-runtime.ts` 增加 `settings`、`settings-empty`、`settings-errors` | — |
| `ui/commands/` | — | `slashCommands.ts`、`StructuredCommandOverlay.tsx` | `ConnectOverlay.tsx` |

`ui/settings/` 按分区分文件，单个文件以不超过约 400 行为目标；表单状态和字段映射放在不依赖 React 的 `.ts` 里，便于单测。

## 风险

| 风险 | 应对 |
|---|---|
| MCP 配置变化后页面仍展示旧数据，或把新配置误当成已生效 | 进入、激活窗口和 Refresh 时分别重读配置与实际状态；测试覆盖 agent 直接修改文件且没有 SSE 通知的情况；断言 MCP 无写入或重连请求 |
| key 出现在页面、日志或控制台 | 统一用 `SecretField`；只允许替换请求体携带新 key，不回显、不持久化、不记录请求正文；检查响应和日志脱敏 |
| 删掉 `/connect` 后无处配置模型 | 设置页与旧浮层的删除在同一批上线 |
