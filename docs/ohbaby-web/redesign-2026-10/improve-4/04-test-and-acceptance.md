# improve-4 · 4. 验收

> 行为验收依据 [08](../08-test-and-acceptance.md) 的 UC-SETTINGS-01 至 05、UC-CHAT-01 中第二批的条目，以及 08 §3 的设置场景。

## 必须通过

| ID | 检查 | 方式 |
|---|---|---|
| D1 | 后端：Models / Web search 校验失败返回 `VALIDATION_FAILED` 和字段路径（不含值）；本期设置读写接口错误带 code；不要求扩展 MCP 写入或重连接口 | server 集成测试 |
| D2 | 五个分区；编辑子页的返回回列表，Back to app/浏览器后退一次回原对话；直达链接的 Back to app 回草稿；刷新可恢复；会话 SSE 不覆盖设置 hash | integration + 浏览器 |
| D3 | Models：分组、Default、Needs setup、行菜单、删除确认（D17）、D20 自动设为默认及其失败路径、从草稿跳来回草稿 | integration（`settings`、`settings-empty`、`settings-errors` 场景） |
| D4 | 模型和搜索只提交改过的字段；密钥三态、label 清空传 null；模型无清除协议的已保存字段被清空时阻止保存，不静默忽略 | unit |
| D5 | MCP：只读全局配置与实际状态，按名字合并，Off / Not connected / — 判定正确；可展开配置、失败原因和工具列表，env/header 仅显示名字 | integration |
| D6 | Skills 只显示全局条目；Web search 字段与范围正确；About 缺少的可选项不显示 | integration |
| D7 | 输入框模型菜单只列配置完整的模型，选中后成为全局默认，无说明文字；失败时恢复原选择 | integration |
| D8 | Web 端没有 `/connect`、`/connect-search` 命令和 `ConnectOverlay`；没配模型时点发送打开设置 › Models；TUI 的 `/connect` 不受影响 | integration + TUI 回归 |
| D9 | 页面可见文本、响应、应用日志、控制台、持久化存储不含测试 key；替换请求体仅发送必要的新值，不记录正文；fields.message 不回显非法输入值 | 走查 + integration |
| D10 | 保留 GET /v1/model，模型切换后 ReasoningControl 刷新；settings.changed 真实转发并让缓存失效；旧读取不覆盖新写入结果，实例状态按目录隔离；ModelMenu 缓存超过 30 秒才重新读取；记住上次分区 | integration |
| D11 | 窄屏下设置先显示分区列表，点进分区后有返回（03 §5）；Web 不再调用 `/v1/settings/search-api-key`；浏览器存储里没有 key | 走查 + unit |
| D12 | `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过 | 命令 |
| D13 | 共用 HTTP 支持 PUT 并保留 fields；校验路径映射到表单；其他窗口先新增模型后，本次 D20 仍选择本次 POST 响应中的新条目 | contract + integration |
| D14 | MCP 无编辑路由、表单、增删、启停或重连入口；Refresh / Retry 只发配置与状态 GET，没有 PUT / DELETE / reconnect POST；agent 改文件后，即使无 SSE 通知也能主动读取，实际连接未更新时不显示假成功 | integration + 浏览器 |
| D15 | 手机（< 640px）输入框次要项收进“更多”（README D29，从 improve-1 移入）；模型、思考与权限入口可达，发送/停止主位保留，无横向溢出；触控区 ≥ 44px，Esc / 取消后焦点返回，开关菜单和调整选项不丢草稿 | integration + 390px 浏览器走查 |

## 视觉走查

按 08 §4 的设置页四行截图检查：导航替换侧栏、行式列表、没有卡片、只有主按钮是实心、Delete 是危险色文字、字段错误在输入框下。
