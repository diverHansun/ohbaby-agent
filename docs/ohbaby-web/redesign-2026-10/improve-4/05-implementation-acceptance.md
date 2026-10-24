# improve-4 · 实施与验收

2026-10-24。基于 `codex/redesign` 的 `6e8b1fc8` 实施，按 [02](02-plan-and-change-scope.md) 的 4a、4b 先后完成。A1–A15 都有对应的测试或走查记录，见下文。

## 实施结果

**Stage A（后端）**

- `global-settings.ts` 的错误处理收进 `settingsFailure` 一个函数。全局设置路由的所有失败都带 code：`UNAUTHORIZED`、`INVALID_JSON`、`REQUEST_TOO_LARGE`、`MODEL_NOT_FOUND`、`MODEL_CONFIG_INCOMPLETE`、`MCP_SERVER_NOT_FOUND`、`VALIDATION_FAILED`、`SETTINGS_ACCESS_FAILED`。
- `VALIDATION_FAILED` 另带 `fields: [{ path, message }]`。`message` 由新文件 `routes/settings-errors.ts` 按 zod 的 issue 类型生成固定文案，不使用 zod 的原始提示，也不回显提交的值。SDK 新增 `UiSettingsErrorResponse` 等类型，并在设置议题 improve-2 的 02、05 里登记。

**4a（客户端、弹窗、Models、Web search、删除旧入口）**

- `api/daemon/settings-client.ts` 封装全部设置接口：全局请求不带目录头，MCP 状态和 Skills 带设置目录。`DaemonRequestError` 保留 `fields`。
- `store/settings-cache.ts` 按 domain 缓存设置数据，MCP 状态和 Skills 再按目录分开。`runtime/settings-layer.ts` 负责读取和写入：写接口的返回值直接替换缓存，按 key 递增的票号让早于写入或更新读取的旧 GET 作废。运行时对外暴露 `runtime.settings`。
- `client-sync` 现在把 `model.invalidated` 和 `settings.changed` 转发给订阅者。运行时订阅当前实例的这两个事件，让对应缓存失效；可见分区会重新读取，窗口重新激活时也会重读。一次写入通常连发两个事件，所以 50ms 内到达的事件合并成一次读取。
- 设置弹窗：侧栏底部加 Settings 入口；弹窗居中，左侧导航，右侧分区；打开后页面其余部分 inert，Tab 在弹窗内循环，× 和 Esc 关闭，点遮罩不关闭，关闭后焦点回到入口。弹窗关闭时只隐藏，再次打开时编辑内容还在；切换分区或刷新页面后才丢弃。上次的分区记在 localStorage。手机上铺满全屏，先显示分区列表。
- Models：按 provider 分组，标出 Default 和 Needs setup，提供行菜单和 provider 菜单。只有删除默认模型和删除整个 provider 时弹确认（D17）。编辑子页只提交改过的字段；API key 用 `SecretField`；Label 清空时传 `null`；没有清除协议的字段被清空时阻止保存，并提供 Restore。D20 取本次 POST 响应里的最后一项设为默认。从草稿点发送打开设置时，默认模型出现后弹窗自动关闭，回到草稿。
- Web search 是一页表单，规则与 Models 相同。
- 删除 `ConnectOverlay` 及其挂载。SDK 的 Web 命令目录不再包含 `connect` 和 `connect-search`，TUI 的命令不受影响。Web 的 `BrowserDaemonClient.connectModel`、`setSearchApiKey`、`probeModelContextWindow` 改为直接拒绝并提示去设置页，对应的 HTTP 方法和 wire 类型已删除。

**4b（MCP、Skills、About、输入框模型菜单、手机“更多”）**

- MCP：全局配置和当前实例的实际状态按名字合并，判定 Off、Not connected、`—`，点一行原地展开只读详情，env 和 header 只显示名字。Refresh 和 Retry 只发两个 GET。状态读取失败时，配置照常显示。
- Skills 只列 `scope === "user"` 的条目，按来源分组。About 的每项可以复制，复制后图标短暂变成勾；没有的项目不显示。
- `ModelMenu`：列出配置完整的模型，最后一项是 `Manage models…`。选中后设为全局默认；失败时恢复原来的名字，并在右上角显示通知；缓存超过 30 秒才重新读取。
- 手机（< 640px）上，权限开关和思考强度收进 `ComposerMoreMenu`：Thinking 在菜单原位切到选项列表，选完回到第一层；Full access 是开关，打开时沿用原来的 “Enable full access?” 确认框。只用 640px 一个断点切换，桌面不变。
- `ReasoningControl` 拆出 `useReasoning`：桌面的 select 和手机菜单共用同一份状态，不会重复请求。

## 与方案的差异

| 方案 | 实际 | 理由 |
|---|---|---|
| `webErrorBody` 加可选 code 参数 | 没改共享 helper，在设置路由内新增 `settingsErrorBody` | code 集合只属于设置路由，放在一起更好找；共享 helper 的其他调用方不受影响 |
| “去掉旧配置写调用” | 删除 HTTP 方法和 wire 类型；Web 客户端上这三个方法改为抛错 | `UiBackendClient` 仍要求这些方法（TUI 在用），不能直接删除；抛错可以保证 Web 不再发请求 |
| ModelMenu 显示当前默认模型名 | 设置缓存读到之前，先显示实例的模型名 | 页面刚打开时按钮不会闪成 `Choose model` |
| 04 §2.6 的焦点规则 | 另加三处焦点保护：弹窗本身可聚焦；聚焦的控件卸载后，焦点回到弹窗；从编辑子页返回时，聚焦刚才编辑的那一行 | 浏览器走查中发现，点到纯文本或点 Save 后，焦点会落到 `<body>`，Esc 就失效了 |
| — | 关闭弹窗时归还焦点放在 passive effect 里执行 | 弹窗只隐藏、不卸载时，React 在 commit 结束后会恢复它之前记下的焦点，覆盖 cleanup 里的设置 |

没有新增依赖、路由库或全局 store 切片，Web 的 `store.ts` 也没有改动。`ui/settings/` 里最大的文件是 `ModelEditor.tsx`（418 行）。

## 验收记录

| ID | 结果与证据 |
|---|---|
| A1 | `settings-global.integration.test.ts` 新增用例，覆盖模型和搜索校验失败的字段路径与固定文案（断言响应里没有 sentinel 值），以及 `MODEL_NOT_FOUND`、`MCP_SERVER_NOT_FOUND`、`UNAUTHORIZED`、`INVALID_JSON`、`REQUEST_TOO_LARGE`、`SETTINGS_ACCESS_FAILED`。真实 daemon 上，Web search 的 Base URL 填 `https://` 后得到 400，原因显示在该输入框下 |
| A2 | 集成测试覆盖：打开时焦点在当前分区，页面 inert，点遮罩不关，Esc 关闭后焦点回到入口，URL 不变；关闭再打开后编辑还在，切换分区后丢弃；删除确认盖在弹窗上面，Esc 只关确认框。浏览器还检查了点纯文本后按 Esc、保存后按 Esc |
| A3 | 集成测试覆盖分组、Default、Needs setup、删除确认只出现在默认模型上，以及从草稿发送 → 新增 → 自动设为默认 → 弹窗关闭、文字还在。真实 daemon 走查了同样的流程；新增第二个模型时默认不变 |
| A4 | `settings-forms.unit.test.ts`：只提交改过的字段，密钥三态，label 清空传 `null`，不能清空的字段阻止保存，Needs setup 补齐后可以保存 |
| A5 | `settings-layer.unit.test.ts` 覆盖按名字合并和 Off / Not connected / unknown 的判定；集成测试覆盖展开详情和失败原因。真实 daemon 中 env、header 的值没有出现在 DOM 里 |
| A6a | 集成测试覆盖添加 key 后显示 Configured、请求只含 `apiKey`、页面不回显；单测覆盖范围、单位和 Base URL 清空传 `null` |
| A6b | 集成测试：项目级 Skill 不显示；About 只显示存在的项。真实 daemon 的 Skills 和 About 读到了临时 home 的数据 |
| A7 | 集成测试：菜单只列配置完整的模型，最后一项是 `Manage models…`，选中后成为默认，没有说明文字；失败时出现通知并恢复原来的名字。真实 daemon 上切换成功 |
| A8 | Web 命令目录不再包含 connect（SDK、server、Web 三层测试都已更新）；Web 客户端不再发旧的写请求（集成测试断言）。CLI 81 个文件、829 个用例通过，TUI 的 `/connect` 不受影响 |
| A9 | 真实 daemon 中，测试 key 没有出现在页面文本、HTML、URL、localStorage、sessionStorage 和 POST 响应里；集成测试也断言了页面文本。前端只在替换 key 的请求体里发送新值，不打印日志 |
| A10a | `settings-layer.integration.test.ts` 通过真实的 `client-sync` 和 SSE 验证两个事件的转发和缓存重读，旧 GET 不覆盖写入结果；真实 daemon 上，模型变化后思考强度控件跟着刷新 |
| A10b | 单测：实例层缓存按目录分开；超过 30 秒才重新读取；只重读可见的分区 |
| A11 | 浏览器 375px 宽度：弹窗铺满全屏，先显示列表，进入分区后有返回按钮，没有横向溢出；Web 不再调用 `search-api-key`（真实 daemon 的资源列表为 0 条） |
| A12 | `pnpm typecheck` 通过；`pnpm lint` 0 errors，122 条 warnings，与开工时一致，本批改动的文件没有新增 warning；`pnpm build` 通过 |
| A13 | `DaemonRequestError.fields` 经运行时集成测试验证（会过滤格式不对的条目）；D20 取本次 POST 响应末项，单测里用“其他窗口先新增的条目”做干扰项 |
| A14 | 集成测试断言 MCP 没有输入框、写入或重连按钮，Refresh 只读两项。真实 daemon 上直接改写 `mcp/settings.json` 后，点 Refresh 不需要事件就能看到新配置，网络里只有 GET；实例还没连接的新服务器显示 `—`，不伪装成已生效 |
| A15 | 集成测试覆盖 Thinking 二级列表与返回、Full access 确认框和焦点回到“更多”。真实 daemon 的手机视口下，控制行只剩“更多”、模型和发送，菜单行高 48px，没有横向溢出 |

| 命令 | 结果 |
|---|---|
| `vitest run apps/ohbaby-web`（开工基线） | 56 文件 / 705 用例 |
| 同一命令，最终实现 | 59 文件 / 719 用例通过（连续跑 3 次结果稳定） |
| `vitest run packages/ohbaby-server packages/ohbaby-sdk` | 55 文件 / 633 用例通过 |
| `vitest run packages/ohbaby-cli` | 81 文件 / 829 用例通过 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 通过 / 0 errors / 通过 |
| `git diff --check 6e8b1fc8 HEAD` | 通过 |

真实走查用的是实际构建后的 daemon。`OHBABY_HOME`、`HOME`、`CODEX_HOME` 都指向临时目录，模型地址是一个不会通的本地端口，测试 key 是自己生成的 sentinel。没有调用外部模型，也没有用到个人配置。走查结束后，临时 daemon、临时目录和预览配置都已清理。

## 视觉

参照 Claude 设置弹窗的结构：顶部标题栏和 ×，左侧导航，右侧是平铺的行加细分隔线，弹窗里不再套卡片。只有 Save 和 Add model 是实心按钮，其余都是文字按钮；Delete 用危险色文字；字段错误写在输入框下方。颜色、圆角和阴影都取自现有 token，没有新增字面量颜色（样式测试通过）。已在 1440、800、375 三种宽度截图检查 Models、编辑子页、Web search、MCP 展开、输入框模型菜单和手机“更多”。

## 遗留与后续

| 事项 | 说明 |
|---|---|
| 草稿态的权限开关显示不更新（改动前就有） | 没有绑定会话时，`PATCH /v1/permission` 返回 `full-access`，但输入框仍显示 default。桌面开关和“更多”的表现一样，不是本批引入的；需要单独查 store 在无会话时如何应用权限状态 |
| 切换模型后 `GET /v1/model` 偏多 | 每个 `model.invalidated` 会同时触发实例模型刷新和 `useReasoning` 刷新，一次切换大约读 4 次。修好事件转发之后才出现，功能正确，可以以后再合并 |
| 弹窗打开时通知点不到 | 通知在 inert 的外壳里。设置页的错误都写在页面内，影响很小 |
| Thinking 选项的真实走查 | 临时环境里没有能识别推理能力的模型，真实走查只看到了 `Thinking: unknown`（不可选）。选项切换由 jsdom 集成测试覆盖 |

## 提交

| 批次 | 提交 | 内容 |
|---|---|---|
| 规划文档 | `e8f21587` · `docs(web): settle the improve-4 plan and pre-work investigation` | 开工前未提交的 improve-4 规划改动和调查记录 |
| Stage A | `07c67d37` · `feat(server): return stable codes and field errors from global settings routes` | 错误码、字段错误、SDK 类型、设置 improve-2 文档登记 |
| 4a | `428417f4` · `feat(web): add the settings dialog with Models and Web search` | 设置客户端、缓存、事件转发、弹窗、Models、Web search、删除 `/connect` |
| 4b-1 | `d199af6d` · `feat(web): add read-only MCP, Skills and About settings` | 三个只读分区、焦点保护、事件合并 |
| 4b-2 | `151a12ec` · `feat(web): pick the default model in the composer and fold phone controls into More` | ModelMenu、手机“更多”、`useReasoning` |
| 验收文档 | 本记录所在提交 | 05 验收、README 批次状态 |
