# 08 测试与验收

> 项目测试规则沿用 [Web 测试约定](../test.md)：`*.unit` / `*.contract` / `*.integration` / `*.smoke`，测试文件放在源码旁边。行为验收与 [improve-1 04](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/04-test-and-acceptance.md) 的 T18–T24 对齐，本文不重复后端场景。

## 1. 验收标准

### UC-DRAFT-01 不选项目发起对话（T18、T19）

- [ ] 打开页面，主区是字标 + 项目选择条（No project）+ 输入框，不要求先打开项目。
- [ ] 点 New chat 不调用创建会话接口，侧栏不增加空会话。
- [ ] 发送后在默认目录创建会话，侧栏 No project 顶部出现该会话并处于选中状态；顶栏显示默认目录路径。
- [ ] 发送请求进行中，发送按钮转圈且不可再次点击。
- [ ] 创建失败时，文字放回输入框，输入框上方显示原因和 Retry。
- [ ] 模型未配置时不显示提示；点发送不创建会话、文字保留，并打开配置入口（第一批 `/connect` 浮层，第二批设置 › Models）。

### UC-DRAFT-02 在项目中发起对话（T18、T19）

- [ ] 用项目选择条选择、更换项目时，输入框文字不变。
- [ ] 从项目分组的 `[+]` 进入时，选择条已选中该项目。
- [ ] 发送后会话出现在该项目分组顶部，顶栏显示该项目路径。
- [ ] 刷新页面后点 New chat，选择条是 No project，不沿用旧的 `selectedDirectory`。

### UC-SIDEBAR-01 打开已有会话（T20）

- [ ] 点击会话后，请求使用该会话的执行目录（有待生效目录时用它），而不是侧栏分组的目录。
- [ ] 从项目移出、但仍在原目录的会话，打开后连接原目录，不连接默认目录。
- [ ] 执行目录不存在时，消息区显示原因和 `Move to project…`，输入框不可发送。
- [ ] 旧格式的 hash 链接能恢复原会话。

### UC-SIDEBAR-02 浏览更多会话（T20、T24）

- [ ] 每个项目分组先显示 6 条，Pinned 先显示 8 条；`Show more · N` 每次多显示 20 条。
- [ ] 已加载的不够时，自动拉下一页全局列表，最终能显示到最早的会话。
- [ ] 分组折叠状态刷新后保持。
- [ ] 窗口重新激活、SSE 重连后，列表更新为服务端最新状态，已展开的更多页不丢。

### UC-SEARCH-01 搜索（T22）

- [ ] `Cmd/Ctrl+K` 或点 Search 格，侧栏里展开搜索框并获得焦点。
- [ ] 能搜到侧栏还没加载的旧会话。
- [ ] 标题命中排在正文命中前面；正文命中有片段，命中词高亮；同一会话只出现一次。
- [ ] 快速输入时只有最后一次查询的结果显示出来。
- [ ] 无结果显示 `No chats match "<关键词>".`；失败显示原因和 Retry，关键词保留。
- [ ] Enter 打开选中结果，搜索收起并恢复会话树。

### UC-PROJECT-01 换项目或移入项目（T21）

- [ ] 会话菜单 › Move to project… 显示项目列表，当前归属标 `(current)` 且不可选。
- [ ] 空闲时换项目：行移到目标分组，下一次发送在目标目录运行。
- [ ] 运行中换项目：当前回复不中断，不出现额外提示；下一轮开始后顶栏目录更新。
- [ ] 失败时行留在原处，右上角出现错误通知。
- [ ] 项目超过 8 个时，列表顶部出现过滤框。

### UC-PROJECT-02 从项目移出（T21）

- [ ] 有项目的会话，项目列表底部有 `Remove from project`；无项目会话没有这一项。
- [ ] 移出后会话出现在 No project，顶栏目录不变。

### UC-SESSION-01 置顶、导出、归档

- [ ] Pin 后会话移到 Pinned 区，不在原分组重复出现；Unpin 后回到原分组。
- [ ] Export… › HTML / JSONL 能下载文件。
- [ ] Archive 后行立即消失，不出现成功提示；如果正在打开这条会话，主区回到草稿态；服务端失败时行恢复并出现错误通知。

### UC-CHAT-01 对话中控制 agent

- [ ] 现有测试全部通过（流式、工具卡、插话、排队、停止、斜杠命令、子代理、上下文用量）。改了 DOM 结构的测试同步修改，不删除场景。
- [ ] 审批出现在消息区内，不盖住整页；可以折叠；侧栏对应行显示琥珀点。
- [ ] 模型、思考强度、权限模式都能在输入框卡片底部的控制行里找到并操作。
- [ ] 第二批：模型菜单按 provider 列出配置完整的模型，选中后成为全局默认，菜单里没有说明文字，最后一项 `Manage models…` 打开设置 › Models；Web 输入 `/connect`、`/connect-search` 不再有对应命令。
- [ ] 上下文用量在顶栏右侧，超过 70% 和 90% 时颜色变化。

### UC-PROJECT-03 打开新项目

- [ ] 侧栏 Projects 的 `[+]` 和项目选择条的 `Open folder…` 都能打开目录选择。
- [ ] 从草稿打开时，新项目被选中，文字保留。

### UC-SETTINGS-01 设置（T23，第二批）

- [ ] 点齿轮打开设置弹窗，左侧只有 Models、MCP、Skills、Web search、About 五项；第一次打开是 Models，之后是上次的分区；× 和 Esc 关闭弹窗，回到原对话，草稿保留；点遮罩不关闭；关闭后再打开，未保存的编辑仍在。
- [ ] 读取和写入响应、可见页面、应用日志、控制台和持久化存储里都找不到测试 key 原文；替换 key 的必要请求体允许携带新值，不记录其正文（07 §4）。
- [ ] 保存成功不出现 `Saved` 等提示；没有改动时 Save 不可点。

### UC-SETTINGS-02 管理模型（第二批）

- [ ] 列表按 provider 分组，顺序与服务端一致；默认模型行尾写 `Default`；Needs setup 的条目没有 Set as default。
- [ ] 新增保存后回到列表，新模型排在末尾：已有默认时默认不变；没有默认时新模型成为默认，从草稿跳来的回到草稿且文字还在。编辑后 id 和位置不变。
- [ ] 表单字段与接口对应：常用字段平铺，Key variable、Context window、Max output、Prompt cache 在 More options 里；页面不显示推理能力。
- [ ] API key：Replace 后保存生效；Clear 后显示 Not set；Not set 时可以 Add key；表单里从不出现已保存的 key。
- [ ] Needs setup 条目：缺 Base URL 或 Protocol 时 Save 不可点；补齐后无需其他改动即可保存，保存后不再显示 Needs setup；没有默认时自动成为默认。
- [ ] 删除普通模型不确认；删除默认模型和删除 provider 弹确认框，确认后列表与服务端返回一致（默认已顺延或为空）。
- [ ] 字段不合法时原因写在对应输入框下，输入保留（依赖 D19 后端前置）。

### UC-SETTINGS-03 查看 MCP 配置与状态（第二批）

- [ ] 只列全局配置的服务器；状态显示 `N tools` / `Failed` / `Off` / `Not connected`；项目和插件来源的服务器不出现。
- [ ] 点一行原地展开只读配置、连接状态、失败原因和工具列表；Environment / Headers 只显示名字，URL 使用脱敏结果。
- [ ] 没有添加、编辑、删除、启停、保存或重连入口，没有 MCP 编辑路由；工具使用不要求用户触发 slash command。
- [ ] Refresh / Retry 只重新读取配置和状态，网络中没有 MCP PUT / DELETE / reconnect POST。
- [ ] ohbaby 修改配置文件后，即使没有 `settings.changed`，进入分区、重新激活窗口或 Refresh 仍能读取最新配置；实际连接状态单独显示，不把配置变更视为已生效。
- [ ] 状态读取失败时保留配置，显示 `—` 和 Retry；空列表只显示 `No MCP servers.`。

### UC-SETTINGS-04 配置联网搜索（第二批）

- [ ] API key 显示 Configured / Not set；Replace、Clear 生效；More options 的字段与接口对应，Timeout 以秒为单位。

### UC-SETTINGS-05 Skills 与 About（第二批）

- [ ] Skills 只显示全局（`scope === "user"`）条目，按来源分组，点开有描述和路径。
- [ ] About 显示版本、ohbaby home、默认工作区；诊断文件和日志目录存在时才显示；复制图标可用且不弹通知。

## 2. 测试分层

| 层 | 工具 | 覆盖 | 不覆盖 |
|---|---|---|---|
| unit | Vitest + Testing Library | `Menu` 的键盘和定位翻转；`SessionRow` 的行尾优先级；侧栏分组选择器（06 §2 的规则）；草稿项目选择的本地读写；搜索防抖和中止 | 真实网络 |
| integration | UI 用假 runtime；运行时用真实 runtime + 假 HTTP/SSE，关键链路再接真实 daemon | 草稿首发、目录切换、`SESSION_MOVED`、分页与刷新；不能用假 runtime 自证 runtime 行为 | 视觉 |
| contract | Web HTTP 适配器与 SDK 类型的合同测试 | Web 新增全局列表、搜索、改归属、设置请求与服务端一致，错误保留 targetDirectory / fields | UI |
| smoke | 现有起站冒烟 | 新外壳能起、能发一条消息 | 细节 |
| 视觉走查 | 浏览器截图 + 模型判断 | 03 §7 的口径 | 像素比对 |

需要同步修改的现有测试：

- [test.md](../test.md) 的 “composer density / chrome” 场景写死了旧尺寸（顶栏约 44px、侧栏顶约 58px、圆形图标主按钮），按 03 改写后再验收。
- `ui/styles.unit.test.ts` 直接断言 CSS，里面有大量字面量颜色（如 `#ffffff`）。样式重写后按新的 token 和结构改写：保留“样式入口顺序”的断言，删除对旧色值的断言，新增“组件样式里不出现字面量颜色（token 文件除外）”的断言。
- `App.unit.test.tsx` 中依赖 `ProjectRail`、“Open a project to get started” 空态的用例改为新的草稿态。

## 3. 关键场景

| 场景 | 来源 | 层 |
|---|---|---|
| 无项目直接发送，在默认目录创建会话 | UC-DRAFT-01、T19 | integration + 走查 |
| 换项目不清空草稿文字 | UC-DRAFT-02、T18 | unit |
| 打开会话使用执行目录，移出后不连默认目录 | UC-SIDEBAR-01、T20 | integration |
| 运行中换项目，回复不中断，下一轮在新目录运行 | UC-PROJECT-01、T21、`pending-move` | integration + 走查 |
| 模型表单提交只带改过的字段，密钥三态映射正确 | 06 §2.2、UC-SETTINGS-02 | unit |
| 设置写入后用返回值替换缓存；`settings.changed` 让对应分区重新读取 | 06 §3.7 | integration |
| MCP 全局列表与实例状态按名字合并，不在全局列表里的名字不显示；`off` / `not-connected` / `—` 判定正确 | 06 §2.2、UC-SETTINGS-03 | unit |
| D20：没有默认时新增或补齐模型后自动设为默认；第二步失败时模型保留、行下显示原因、不回到草稿；从草稿点发送打开设置时，设为默认成功后关闭弹窗回到草稿（06 §3.7） | 06 §1.3、§3.7 | integration |
| ModelMenu 选择成功后默认改变；失败时恢复原选择并出现通知 | 05 ModelMenu | integration |
| 删除确认只出现在删除默认模型和删除 provider 时（D17） | 04 §2.6 | unit |
| `SESSION_MOVED` 自动换目录重发，界面无感知 | 06 §4 | integration |
| 搜到未加载的旧会话，快速输入只显示最后结果 | UC-SEARCH-01、T22、`many` | integration |
| 刷新、重连后列表同步，已展开页不丢 | UC-SIDEBAR-02、T24 | integration |
| 菜单完全可用键盘操作，关闭后焦点归还 | 05 Menu、07 §1 | unit |
| 审批浮层不遮挡、可折叠、多请求可翻页 | UC-CHAT-01、`running` | integration + 走查 |
| Esc 一次只关一层，不抢输入框的 Esc | 04 §3 | unit |
| 草稿换项目后文字仍在（草稿 key 不含目录） | 06 §3.5 | unit |
| 旧的按目录置顶迁移到全局 key | 06 §3.6 | unit |
| 创建成功但首发失败只重试 prompt；请求期间切换会话，晚到结果不抢回选择；移动重发保持幂等键和正文 | 06 §3.5、02 §3.2 | runtime integration |
| 超过 100 条后，空项目组和未加载置顶仍能继续翻页；外部归档/隐藏/改归属后重新激活，旧页不留下失效行 | 06 §3.1–§3.2 | runtime integration |
| 其他目录会话的归档/导出不切当前 SSE；当前会话归档失败保留主区 | improve-3 | integration |
| 设置弹窗的打开、关闭、Esc 分层、焦点进出；关闭再打开恢复编辑状态；弹窗不改 URL | 01 §1.2、04 §2.6 | integration + 浏览器 |
| 旧 GET 不覆盖模型/搜索写入结果，MCP 状态按目录隔离；模型不能清空的字段阻止保存 | 06 §2.2、§3.7 | unit + integration |
| MCP 全程只读，无编辑表单、写入或重连请求；agent 文件修改后，无事件时也能通过主动读取更新 | D25、06 §3.7 | integration + 走查 |
| 界面结构符合线框，品牌三色只在字标 | 03 §1、§4 | 走查 |

## 4. 视觉验收清单

在 `vite dev` 下用 06 §5 的 Mock 场景截图（标为“按需”的场景在走查前补上）；最后用真实 daemon 再走一遍 improve-1 04 §4.5 的流程。

| 页面 | 场景 | 视口 | 检查点 |
|---|---|---|---|
| 草稿态 | `fresh` | 1440、390 | 字标、选择条、输入框成组居中；只有输入框卡片，没有标语或示例卡片；侧栏没有引导文案，只有 Projects 旁的 `[+]` |
| 草稿态 | `no-model` | 1440 | 没有任何未配置提示；点发送后打开配置入口 |
| 会话态 | `running` | 1440、900 | 线框结构；两条顶栏连成一条；用户消息、助手文字、过程折叠行的层次；控制行是无边框文字按钮；Stop 和发送一样是黑色圆钮（D32） |
| 会话态 | `running`（切到等待审批） | 1440 | 审批浮层位置、不遮挡、琥珀点、多请求翻页 |
| 会话态 | `pending-move` | 1440 | 没有待生效提示；顶栏仍是当前目录 |
| 侧栏 | `typical` | 1440 | 行高、选中竖条、分组标题样式、hover 出现的按钮、Show more |
| 侧栏菜单 | `typical` | 1440、390 | 两级菜单视图；手机端底部弹出 |
| 侧栏搜索 | `search` | 1440 | 结果行结构、高亮、无结果文案 |
| 整体 | `typical` | 900、390 | 03 §5 响应式行为：窄桌面侧栏覆盖、手机抽屉 |
| 整体 | 全部 | 1440 | 与 Claude、Codex、Cursor 参考截图并排对比：中性偏暖白、侧栏深一档、玻璃只在浮起元素上、留白和密度接近；界面上除字标外没有金粉蓝 |
| 设置页 · Models | `settings` | 1440、390 | 居中弹窗（390 下铺满全屏）；按 provider 分组的行；Default、Needs setup 的层次；弹窗内不再套卡片 |
| 设置页 · 模型编辑 | `settings` | 1440 | 字段顺序与线框一致；More options 折叠；只有 Save 是实心按钮；Delete 是危险色文字 |
| 设置页 · Web search | `settings` | 1440 | 单页表单；API key 显示 Configured / Not set，不回显值；More options 折叠；字段错误在输入框下 |
| 设置页 · MCP | `settings` | 1440 | 名称与状态文字、原地展开的只读配置和工具列表；无输入框、开关或写操作按钮；Refresh 是文字按钮 |
| 设置页 · 空态与错误 | `settings-empty`、`settings-errors` | 1440 | 空态各一行；模型/搜索字段错误在输入框下；MCP 状态读取失败时配置仍可查看 |

检查点只判断“对不对”，不比像素。结论写进 09 验收文档。
