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

初次实施没有新增依赖、路由库或全局 store 切片，也未改 Web 的 `store.ts`。下方独立复查为草稿权限补上了 store 状态；没有增加依赖或改变设置页布局。

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
| 草稿态的权限开关显示不更新（改动前就有） | 独立复查已修复：消费保存响应和权限事件，不再依赖已有会话。补了旧请求和过期事件的回归测试，并在浏览器验证 |
| 切换模型后 `GET /v1/model` 偏多 | 独立复查已合并同一实例内正在进行的读取：模型状态与 Thinking 共用请求。测试断言一次失效事件与订阅者刷新只发一次 GET；新的失效事件仍会重新读取 |
| 弹窗打开时通知点不到 | 保持模态语义：背景通知在 inert 外壳里，关闭设置后可以操作。设置错误在分区内显示，不依赖点击背景通知 |
| Thinking 选项的真实走查 | 独立复查已在真实 daemon 的手机视口下从 low 切到 high，再发送消息；本地模型服务实际收到 `reasoning_effort: "high"`。该服务是可控测试替身，未验证外部供应商 |

## 独立复查与修复（2026-10-25）

复查范围为 `6e8b1fc8..44b4f995` 的六次提交、设计与接口文档，以及截图中的实施汇报。分别检查代码行为和方案完成度，再对可复现的问题补测试、修代码。原记录中的测试通过不能代替这些边界检查。

| 问题 | 修复与验证 |
|---|---|
| 旧模型没有密钥引用时，留空保存仍可能停在 Needs setup | 补齐地址和协议后，显式提交 `apiKeyEnv: null` 确认无需密钥。已有引用、新密钥和外部刚补上的引用均保留。表单及交互测试覆盖；真实 daemon 上保存成功、自动设为默认并保留草稿 |
| 编辑期间刷新缓存会让未修改的旧字段被发回，覆盖其他窗口的新值 | 模型按打开编辑时的值比较，搜索按开始编辑时的值比较；只提交用户改过的字段。保存期间用原生 fieldset 禁用控件，模型选择等待上次请求完成。回归覆盖并发刷新和未完成请求 |
| 脱敏地址只改一部分后保存，会把 `[REDACTED]` 写成真实配置 | 修改地址且仍含遮罩时阻止保存，提示完整替换；不改地址时仍能保存其他字段。模型与搜索各有回归，浏览器验证错误提示和只改超时成功，磁盘地址原值未变 |
| MCP Args 直接返回敏感启动参数，与只读页不回显密钥的约定不符 | 只在接口投影里遮住敏感 flag、header、URL 和已知 env 值；覆盖分开的参数、等号、shell 命令及带引号的值。GET/写入响应测试均不含测试密钥，磁盘中的可执行参数保持原样；浏览器确认 Args 显示遮罩 |
| 草稿 Full access 保存成功后仍显示 default | 独立存储当前权限，接受保存响应及有效的权限事件；实例已切换或已关闭时忽略旧响应。补回归并完成真实 daemon 走查 |
| 模型按钮在菜单关闭时不订阅刷新，重新激活页面时模型与 Thinking 也可能落后 | 按钮可见时订阅模型缓存；focus 和 visibilitychange 同时刷新发送检查与 Thinking；共用正在进行的模型读取，避免重复 GET。测试覆盖外部事件、无事件的激活刷新；浏览器模拟另一个客户端切换默认模型，标签与 Thinking 随之更新 |
| 隐藏的设置弹窗仍声明 aria-modal，响应式隐藏控件也被算入焦点循环 | 仅打开时声明模态，Tab 候选排除 CSS 隐藏元素。补全局快捷键和焦点回归；桌面与手机验证 Tab 循环，关闭后 Cmd+K 正常打开搜索 |

修改沿用现有组件和缓存，没有引入表单框架、状态库或通用协调层。UI 仅增加保存期间的禁用状态和字段错误提示，布局不变。

最终验证：

| 范围 | 结果 |
|---|---|
| Web | 62 文件 / 739 用例通过 |
| Server + SDK | 55 文件 / 633 用例通过 |
| CLI | 81 文件 / 829 用例通过 |
| Agent 的 LLM / MCP / secrets 配置 | 24 文件 / 229 用例通过 |
| 合计 | 222 文件 / 2430 用例通过 |
| `pnpm typecheck` / `pnpm build` | 通过 |
| `pnpm lint` | 0 errors / 122 条已有 warnings，本次文件无新增 warning |
| 改动代码的 Prettier / `git diff --check` | 通过 |

浏览器使用实际构建后的 Web 和真实 daemon，设置、数据库和日志写入临时 `OHBABY_HOME` 等目录，未修改个人配置。模型服务是本地 OpenAI-compatible 测试替身，以临时配置声明推理能力并返回确定的回复：验证了草稿配置后继续发送、手机 Thinking、默认模型切换、搜索保存、MCP 详情、Skills 与 About。检查了 375px 和 800px 视口及键盘操作；没有重做 UI。未调用外部模型或验证真实搜索供应商。

截图保存在本次审查对话中，包括 800px 设置页与 MCP 脱敏参数、375px 手机 MCP 详情、脱敏地址保存保护，未纳入仓库。

## 合并前回归修复（2026-10-25）

在 `a7cefe6e` 上再次检查合并条件，确认三处边界问题。用户要求直接修复、补回归、测试后提交，并明确本轮不合并到 `main`。

| 问题 | 修复与回归 |
|---|---|
| MCP 的 `-H'Authorization: Basic …'` 和无引号 `--header=X-Custom-Auth:…` 仍会显示凭据 | 将参数中的敏感值收集集中到 `settingsSecrets`，Args 和 Error 使用同一批值脱敏。覆盖紧贴 `-H`、长参数等号、引号、完整命令报错和只包含凭据的报错。普通端口与 debug 参数保留；writer 回归确认落盘参数仍是原值 |
| 连续选择两个模型，第一次写入的响应晚到，会把前端缓存退回旧模型 | Models、Search 各自按调用顺序完成写入及缓存更新。一个请求失败不阻断后续写入，两分区互不等待。集成回归用真实设置客户端加延迟 HTTP 响应，断言服务端状态与前端缓存均保留最后一次修改，同时保留旧 GET 不覆盖新写入的回归 |
| 首条发送尚未确认时新建草稿，旧临时消息会留在新草稿中 | 给本地发送记录保存已有的 client 与选择代次，隔离无会话草稿。回归检查旧首发晚成功、晚失败、换 client、新文字保留、欢迎区和项目选择器恢复、继续发送，以及正常首发绑定和绑定等待期间的消息显示 |

三类回归均先观察到修复前失败，再改为通过。复审还发现 client 更换也用于已绑定会话的 `SESSION_MOVED` 自动迁移，因此补充迁移期间的发送保护和晚失败提示检查，不能把这种迁移误当成用户新建草稿。

实现沿用现有 Promise 队列、选择代次和消息投影。没有新增依赖、通用状态框架或 UI 样式改动，也没有改未知发送结果的恢复账本。

最终验证（相关模块测试与全仓单测有重叠，不相加）：

| 范围 | 结果 |
|---|---|
| Web、Server、SDK、CLI、Agent 的 LLM / MCP / secrets 配置测试 | 222 文件 / 2459 用例通过 |
| `pnpm test:unit` | 371 文件 / 4653 用例通过，2 项原有跳过 |
| `pnpm typecheck` / `pnpm build` | 通过；CLI 已复制本次 Web 构建 |
| `pnpm lint` | 0 errors / 122 条已有 warnings |
| Standards / Spec 独立复审 | 本轮修复无未解决的阻塞项；Standards 指出的自动迁移回归已补测并复验 |

电脑操作使用真实构建产物、临时 daemon 和本地模型替身。临时代理只控制响应时序：首条发送挂起时新建草稿，放行后旧气泡不再出现，欢迎区、项目选择器和新文字保留，Send 恢复可用；继续发送得到正常回复。设置页先选 review-b，挂起响应期间再选 review-c，放行后页面 Default 与磁盘 `activeProfileId` 都为 review-c。MCP 详情将两种 header 参数显示为 `[REDACTED]`，普通 `--port 8080` 保留，磁盘参数原值不变。浏览器 warn/error 日志为空。

本轮只重测这些行为，没有重新声明所有尺寸和外部供应商都已验证。页面截图保留在审查对话中，未加入仓库；测试服务、代理与临时配置已清理。

合并条件核对：远端 `main` 已重新获取，仍为 `f5f36b9e`，是当前分支的祖先。代码与本轮验收没有剩余阻塞；本地 `main` 未改动，修复仅提交到 `codex/redesign`。该分支包含 improve-1 至 improve-4，后续合并时应按这整段改动处理。

## 提交

| 批次 | 提交 | 内容 |
|---|---|---|
| 规划文档 | `e8f21587` · `docs(web): settle the improve-4 plan and pre-work investigation` | 开工前未提交的 improve-4 规划改动和调查记录 |
| Stage A | `07c67d37` · `feat(server): return stable codes and field errors from global settings routes` | 错误码、字段错误、SDK 类型、设置 improve-2 文档登记 |
| 4a | `428417f4` · `feat(web): add the settings dialog with Models and Web search` | 设置客户端、缓存、事件转发、弹窗、Models、Web search、删除 `/connect` |
| 4b-1 | `d199af6d` · `feat(web): add read-only MCP, Skills and About settings` | 三个只读分区、焦点保护、事件合并 |
| 4b-2 | `151a12ec` · `feat(web): pick the default model in the composer and fold phone controls into More` | ModelMenu、手机“更多”、`useReasoning` |
| 验收文档 | 本记录所在提交 | 05 验收、README 批次状态 |
