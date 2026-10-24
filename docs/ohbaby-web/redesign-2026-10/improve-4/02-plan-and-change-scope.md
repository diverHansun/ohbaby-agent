# improve-4 · 2. 方案与改动面：设置页

> 依据：[01 §2.9、UC-SETTINGS-01 至 05](../01-use-cases-and-user-flows.md)、[03 §4.7](../03-ui-layout-and-style.md)、[04 §2.6](../04-interaction-and-states.md)、[05](../05-components.md)、[06 §1.3、§2.2、§3.7](../06-data-api-and-state.md)，决策 D12–D20、D25。现状见 [01](01-current-state.md)，验收见 [04](04-test-and-acceptance.md)。

## 目标

整页设置：Models、MCP、Skills、Web search、About 五个分区。MCP 只展示配置和状态，配置修改继续交给 ohbaby；输入框的模型按钮直接选择全局默认模型；Web 端删掉 `/connect` 浮层。

## 范围

**Stage A · 后端前置（D19）**：

- Models / Web search 写接口的校验失败返回 `{ ok: false, error: { code: "VALIDATION_FAILED", message, fields: [{ path, message }] } }`，不含字段值。
- 本期 Web 使用的设置读写接口错误都带 `code`（如 `MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE`）。不扩展 MCP 写入、名称校验或重连错误协议。
- SDK `contract/settings.ts` 补错误类型；在设置议题的 improve-2 文档里登记这次补充。
- `fields[].path` 采用字段路径数组（如 `["defaults", "timeout"]`），message 使用安全的字段级说明，不序列化原始 Zod issue、请求值或包含凭据的 URL；鉴权、缺目录、非法 JSON、超大请求和服务不可用也有稳定 code。

**Stage B · 前端**：

1. **设置客户端**：`api/daemon/settings-client.ts`，扩展 improve-2 的最小模型读取能力；全局请求不带目录头，实例请求带“设置目录”（06 §3.7）。只依赖 SDK 类型，共用传输增加 PUT 和结构化错误 fields。
2. **页面骨架**：`ui/settings/SettingsPage.tsx` 按 hash 切换分区和编辑子页；进入设置只 push 一条历史，内部切换 replace，history 与返回规则见 01 §1.2；`SettingsNav` 替换侧栏内容。
3. **Models**：`ModelsSection`（按 provider 分组、行菜单、provider 组菜单、删除确认 D17）、`ModelEditor`（常用字段加 More options，只提交改过的字段，`SecretField`）、D20 自动设为默认、从草稿跳来时回草稿。
4. **MCP**：`McpSection`（全局配置列表合并实例状态）、`McpDetails`（原地展开只读配置、失败原因和工具列表）。只接两个 GET；Refresh 重新读取，不触发重连。没有表单、启停开关、添加或删除入口，配置修改继续交给 ohbaby（D25）。
5. **Skills、Web search、About**：各一个小组件。
6. **输入框模型菜单与手机控制行**（D29）：`ui/composer/ModelMenu.tsx`，读全局模型列表，选中调用 `POST /v1/settings/models/active`；`ReasoningControl` 在模型变化后刷新。同步完成从 improve-1 移入的手机“更多”：< 640px 时收纳次要选项，仍能访问模型、思考与权限控制，发送/停止保留主位；复用共享 `Menu`，不新增一套控制状态，保持草稿与焦点。
7. **删除旧入口**（D18）：删除 `ConnectOverlay` 及 `StructuredCommandOverlay` 中的挂载；SDK `web-passthrough.ts` 不再向 Web 暴露 `connectModel`、`connectSearch` 两个 action（TUI 的命令路径保持不变）；`UiBackendClient.connectModel` 保留给 TUI。没配模型时点发送改为打开设置 › Models。
8. **刷新**：写接口返回值替换缓存；`settings.changed`、进入分区、窗口重新激活时重新读取（06 §3.7）。

保留 `GET /v1/model` 及现有 `model.invalidated` 对实例状态和 ReasoningControl 的刷新；只移除旧配置写入口。设置缓存按 domain 和实例目录划分，独立文件组织；请求 generation 防止旧 GET 覆盖新写结果。表单字段清空按 06 §2.2 执行，不能把用户改动静默丢弃。

不做：Agents 分区、项目级配置、MCP 配置写入/启停/重连/OAuth、推理能力展示与手动探测、`/v1/model` 等旧接口下线（00 Non-goals）。现有 MCP 写入与重连服务端接口保留。

## 改动面

| 位置 | 新增 | 修改 | 删除 |
|---|---|---|---|
| `ohbaby-server/src/protocols/web/routes/global-settings.ts`、`routes/settings.ts` | — | 本期设置读写接口的错误码；Models / Web search 校验字段信息 | — |
| `ohbaby-sdk/src/contract/settings.ts` | 错误类型 | — | — |
| `api/daemon/` | — | 扩展 `settings-client.ts`；`http.ts` 增加 PUT、fields，去掉旧配置写调用；client 转发设置失效事件 | — |
| `store/` | 按 domain 组织的设置缓存与选择器 | 统一入口接线 | — |
| `ui/settings/` | `SettingsPage`、`SettingsNav`、各分区、模型编辑子页、`SecretField`；`mcp/` 内为只读列表与详情 | — | — |
| `ui/shared/` | `SettingsRow`、`ConfirmDialog` | — | — |
| `ohbaby-sdk/src/slash-command/web-passthrough.ts` | — | Web 端不再提供 connect 两个 action | — |
| `ui/composer/` | `ModelMenu.tsx` | `ComposerControls`、`ReasoningControl` | — |
| `ui/commands/` | — | `slashCommands.ts`、`StructuredCommandOverlay.tsx` | `ConnectOverlay.tsx` |

`ui/settings/` 按分区分文件，单个文件以不超过约 400 行为目标；表单状态和字段映射放在不依赖 React 的 `.ts` 里，便于单测。

## 风险

| 风险 | 应对 |
|---|---|
| MCP 配置变化后页面仍展示旧数据，或把新配置误当成已生效 | 进入、激活窗口和 Refresh 时分别重读配置与实际状态；测试覆盖 agent 直接修改文件且没有 SSE 通知的情况；断言 MCP 无写入或重连请求 |
| key 出现在页面、日志或控制台 | 统一用 `SecretField`；只允许替换请求体携带新 key，不回显、不持久化、不记录请求正文；检查响应和日志脱敏 |
| 删掉 `/connect` 后无处配置模型 | 设置页与旧浮层的删除在同一批上线 |
