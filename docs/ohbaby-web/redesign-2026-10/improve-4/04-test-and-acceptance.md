# improve-4 · 4. 验收

> 行为验收依据 [08](../08-test-and-acceptance.md) 的 UC-SETTINGS-01 至 05、UC-CHAT-01 中第二批的条目，以及 08 §3 的设置场景。

## 必须通过

验收项用 A 前缀编号，避免和 README 的决策编号 D1–D32 混淆。“批次”列说明该项在哪一批验收（见 [02 批次](02-plan-and-change-scope.md#批次2026-10-24-确认)）。4b 验收时，4a 的各项要回归一遍。

| ID | 批次 | 检查 | 方式 |
|---|---|---|---|
| A1 | 4a | 后端：Models / Web search 校验失败返回 `VALIDATION_FAILED` 和字段路径（不含值），`fields[].message` 是固定文案、不回显输入；`global-settings.ts` 的所有错误响应都带 code（含 `MCP_SERVER_NOT_FOUND`、鉴权、非法 JSON、请求体过大、兜底 500）；SDK 有 `UiSettingsError`，并在设置议题 improve-2 文档里登记；实例层设置路由和 MCP 写入、重连接口不在范围内 | server 集成测试 + contract |
| A2 | 4a | 设置是居中弹窗，4a 只有 Models、Web search 两个分区，4b 补齐五个；打开时焦点移入、Tab 在弹窗内循环；编辑子页的返回回列表；× 和 Esc 关闭并把焦点还给齿轮，点遮罩不关闭；弹窗里的菜单和删除确认盖在弹窗上面；关闭再打开恢复未保存的编辑，切到其他分区后丢弃；打开、切换、关闭都不改 URL | integration + 浏览器 |
| A3 | 4a | Models：分组、Default、Needs setup、行菜单、删除确认（D17）、D20 自动设为默认及其失败路径；从草稿点发送打开时直接进 Models，默认模型从无变有后关闭弹窗回到草稿、文字还在，用户自己关闭则清除这个行为 | integration（`settings`、`settings-empty`、`settings-errors` 场景） |
| A4 | 4a | 模型和搜索只提交改过的字段；密钥三态、label 清空传 null；模型无清除协议的已保存字段被清空时阻止保存，不静默忽略 | unit |
| A5 | 4b | MCP：只读全局配置与实际状态，按名字合并，Off / Not connected / — 判定正确；可展开配置、失败原因和工具列表，env/header 仅显示名字 | integration |
| A6a | 4a | Web search 字段与范围正确 | integration |
| A6b | 4b | Skills 只显示全局条目；About 缺少的可选项不显示 | integration |
| A7 | 4b | 输入框模型菜单只列配置完整的模型，最后一项是 `Manage models…`；选中后成为全局默认，无说明文字；失败时恢复原选择 | integration |
| A8 | 4a | Web 端没有 `/connect`、`/connect-search` 命令和 `ConnectOverlay`；没配模型时点发送打开设置 › Models；4a 期间模型按钮点击打开设置 › Models；TUI 的 `/connect` 不受影响 | integration + TUI 回归 |
| A9 | 4a | 页面可见文本、响应、应用日志、控制台、持久化存储不含测试 key；替换请求体仅发送必要的新值，不记录正文；`fields[].message` 不回显非法输入值 | 走查 + integration |
| A10a | 4a | 保留 `GET /v1/model`；`model.invalidated` 经 `client-sync` 真实转发，模型切换后 ReasoningControl 刷新（测试不能直接调用 handler）；`settings.changed` 真实转发并让缓存失效；进入分区、窗口重新激活时重新读取；旧读取不覆盖新写入结果；记住上次分区 | integration |
| A10b | 4b | 实例层状态（MCP、Skills）按设置目录隔离；ModelMenu 缓存超过 30 秒才重新读取 | integration |
| A11 | 4a | 窄屏下设置弹窗铺满全屏，先显示分区列表，点进分区后有返回（03 §5）；Web 不再调用 `/v1/settings/search-api-key`；浏览器存储里没有 key | 走查 + unit |
| A12 | 4a、4b | `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过 | 命令 |
| A13 | 4a | `DaemonRequestError` 保留 fields；校验路径映射到表单；其他窗口先新增模型后，本次 D20 仍选择本次 POST 响应中的新条目 | contract + integration |
| A14 | 4b | MCP 无编辑路由、表单、增删、启停或重连入口；Refresh / Retry 只发配置与状态 GET，没有 PUT / DELETE / reconnect POST；agent 改文件后，即使无 SSE 通知也能主动读取，实际连接未更新时不显示假成功 | integration + 浏览器 |
| A15 | 4b | 手机（< 640px）输入框次要项收进“更多”（README D29，从 improve-1 移入）：控制行只露出“更多”、模型和发送/停止；“更多”里的 Thinking 在原地切到选项列表并能返回，Full access 打开时仍弹出现有确认框；无横向溢出；触控区 ≥ 44px，Esc / 取消后焦点返回，开关菜单和调整选项不丢草稿；桌面控制行不变 | integration + 390px 浏览器走查 |

## 视觉走查

按 08 §4 的设置页截图检查（4a 查 Models、模型编辑、Web search 和空态与错误里的模型/搜索部分；4b 查 MCP 和其余部分）：居中弹窗（手机全屏）、行式列表、弹窗内不再套卡片、只有主按钮是实心、Delete 是危险色文字、字段错误在输入框下。
