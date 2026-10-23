# ohbaby Web 改版设计（2026-10）

2026-10-22 开始讨论。本组文档用 plan-frontend-design 的完整模式（00–08）撰写，规划阶段不写代码。

本轮做两件事：一是重做 Web 的整体外壳与视觉（侧栏、输入框、空状态），二是新增整页设置。改版同时接上 [无工作区会话与设置](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/README.md) improve-1 中尚未实施的 Web 部分，以及 improve-2 已完成的设置后端。会话与项目的产品行为以 improve-1 为准，设置的接口与行为以 improve-2 为准，本组文档只补前端的结构、交互与视觉。

## 已确认的决策

| # | 决策 | 确认日期 |
|---|---|---|
| D1 | 实施顺序：先“外壳 + 视觉 + 第一批 Web（工作区绑定）”，再“设置页”。设置后端已在 improve-2 完成（2026-10-23 更新） | 2026-10-22 |
| D2 | 设置做成整页，替换主区，左侧竖排导航；入口是侧栏左下角的齿轮 | 2026-10-22 |
| D3 | 布局整体借鉴 pi-web：两栏（侧栏 + 主区），去掉现有最左侧的项目图标栏 | 2026-10-22 |
| D4 | 视觉走高级简约路线（参考 Apple、Tesla、Anthropic、OpenAI 及 Claude / Codex 桌面端）：少用卡片，不做卡片套卡片、按钮套按钮 | 2026-10-22 |
| D5 | 产品品牌只保留三色“oh/ba/by”字标（保留颜色与字形，缩小尺寸），只放在侧栏左上角；除字标和 Lychee 标识（D26）外，界面用黑白灰；不使用卡通 logo 徽章 | 2026-10-22，2026-10-24 改 |
| D6 | 不显示“已连接”这类常态信息，只在异常时提示 | 2026-10-22 |
| D7 | 本轮不做暗色模式 | 2026-10-22 |
| D8 | 不迁移到 Tailwind 或 shadcn，继续使用手写 CSS；图标与交互基础组件的选型见 02 | 2026-10-22 |
| D9 | 文档里的布局用 ASCII 线框表达；CSS 只给方向和初值，不写死，留给实施发挥 | 2026-10-22 |
| D10 | 03 的线框大致确认；细节照 pi-web 做（侧栏、菜单、输入框、消息、搜索、通知），不再逐项讨论。因此菜单照 pi-web 自己写，不引入 Radix；搜索在侧栏内展开 | 2026-10-22 |
| D11 | ~~底色用 pi-web 的 `sand` 暖纸色~~，2026-10-23 由 D21 取代 | 2026-10-22 |
| D12 | 设置只有 5 个分区：Models、MCP、Skills、Web search、About。去掉 General（没有可放的前端偏好）和 Agents（只读，用户用不上） | 2026-10-23 |
| D13 | MCP 和 Skills 按全局呈现：页面只列全局条目，不显示项目、插件来源的条目或“被项目覆盖”提示。MCP 配置修改按 D25 交给 ohbaby | 2026-10-23 |
| D14 | Models 用“列表 + 编辑子页”；表单字段与 improve-2 接口一一对应，常用字段平铺，其余收进 More options。推理能力不在设置页显示，由后端自动探测，用户在输入框的思考强度里调整 | 2026-10-23 |
| D15 | 输入框控制行的模型按钮可以直接选择模型，选中即设为全局默认，不加说明文字 | 2026-10-23 |
| D16 | 少提示：只在操作失败或用户没法继续时提示，其他情况不出声。第一批已按这条删减（03 §1、04 §2） | 2026-10-23 |
| D17 | 只有删除整个 provider、删除当前默认模型时弹确认框；删除普通模型直接执行。MCP 不提供删除入口（D25） | 2026-10-23 |
| D18 | Web 端删除 `/connect`、`/connect-search` 两个命令和对应浮层，入口统一到设置页（第二批上线时删除）；TUI 保留 | 2026-10-23 |
| D19 | 第二批的后端前置：Models / Web search 写接口返回结构化校验错误，本期 Web 使用的设置读写接口统一错误码；MCP 写入与重连接口不属于本批前置（06 §1.3） | 2026-10-23 |
| D20 | 当前没有默认模型时，新增模型、或把 Needs setup 条目补齐保存后，前端立即把它设为默认；已有默认时，新增不改变默认（后端规则不变） | 2026-10-23 |
| D21 | 配色改为中性偏暖白加轻玻璃，对齐 Claude、Codex、Cursor 桌面端；玻璃只用在顶栏、菜单、通知、输入框卡片等浮起元素上（03 §2、§3.1） | 2026-10-23 |
| D22 | 输入框控制按钮放进卡片底部：左边权限模式，右边模型、思考强度、圆形发送；项目选择在卡片上方。附件入口本次隐藏，后续再做（用户已确认） | 2026-10-23 |
| D23 | 新对话空状态是 Lychee 标识加居中的项目选择和输入框卡片，照 Cursor（原为中号字标，见 D26） | 2026-10-23，2026-10-24 改 |
| D24 | 实施分 4 批：improve-1 视觉基础与外壳 → improve-2 会话中心运行时、草稿与全局侧栏 → improve-3 项目菜单与搜索 → improve-4 设置页。每批独立可运行、可验收；拆大文件随所在批次进行 | 2026-10-23 |
| D25 | Settings 中 MCP 只展示配置和状态，配置修改继续交给 ohbaby。MCP 工具由运行时加载后直接加入 agent 的工具列表，无需用户用 slash command 触发；Web 不提供 MCP 添加、编辑、删除、启停或重连操作 | 2026-10-23 |
| D26 | 区分产品和 agent：ohbaby 是产品，字标只在侧栏左上角出现一次；Lychee 是 agent 的“人格”名字，用单色线性荔枝图标（`--brand-lychee` #c0444f）作为标识，放在空状态中央（约 40px）和 favicon。不加标语或问候语 | 2026-10-24 |

## 文档地图

2026-10-22 全部写完草稿，经过一轮自查和子代理审查，审查发现的 16 个问题已修正。2026-10-23 按 improve-2 的实际接口补齐设置页（D12–D20），并按“少提示”原则删减了第一批的提示；随后经子代理审查，修正了遗留的旧提示、与后端字段语义不一致处（MCP 地址脱敏、清除 key 与无 key 模式相同、部分字段无法清空）和跨文档不一致。

| 文件 | 内容 | 状态 |
|---|---|---|
| [00-goal-duty.md](00-goal-duty.md) | 目标、使用阶段、核心任务、前后端分界、Non-goals | 已确认（2026-10-22） |
| [01-use-cases-and-user-flows.md](01-use-cases-and-user-flows.md) | 信息架构、用户流程、用例 | 已确认（2026-10-22） |
| [02-frontend-architecture.md](02-frontend-architecture.md) | 技术栈边界、运行时分层、状态分类、错误处理 | 草稿，按 D10 更新 |
| [03-ui-layout-and-style.md](03-ui-layout-and-style.md) | 设计原则、视觉方向、tokens、ASCII 线框、响应式、文案 | 线框大致确认，细节按 pi-web 补齐 |
| [04-interaction-and-states.md](04-interaction-and-states.md) | 组件状态、页面状态矩阵、交互语义 | 草稿，待确认 |
| [05-components.md](05-components.md) | 组件索引与关键组件契约 | 草稿，待确认 |
| [06-data-api-and-state.md](06-data-api-and-state.md) | API 映射、ViewModel、刷新与分页策略、错误映射、Mock 场景 | 草稿，待确认 |
| [07-quality-constraints.md](07-quality-constraints.md) | 无障碍、性能、兼容性、安全 | 草稿，待确认 |
| [08-test-and-acceptance.md](08-test-and-acceptance.md) | 验收标准、测试分层、视觉验收清单 | 草稿，待确认 |

## 实施批次（D24）

| 批次 | 内容 | 依赖 | 文档 |
|---|---|---|---|
| improve-1 | 设计 token、全局样式重写、基础组件、两栏外壳、顶栏、消息与审批换肤；拆 `SessionScreen`、`Composer` | 无 | [improve-1](improve-1/02-plan-and-change-scope.md) |
| improve-2 | 全局会话客户端、按会话目录连接的运行时、草稿首发与项目选择、全局侧栏（分组、分页、置顶迁移）、`SESSION_MOVED`；拆 `client.ts`、`runtime.ts` | improve-1 | [improve-2](improve-2/02-plan-and-change-scope.md) |
| improve-3 | 会话菜单（移入、换项目、移出、归档、导出）与侧栏全局搜索 | improve-2 | [improve-3](improve-3/02-plan-and-change-scope.md) |
| improve-4 | 后端前置 D19、设置 API 客户端、5 个设置分区、输入框模型菜单、删除 `/connect` 浮层 | improve-1、improve-2（设置目录与“回到草稿”依赖新运行时）；D19 | [improve-4](improve-4/02-plan-and-change-scope.md) |

00–08 里写的“第一批”对应 improve-1 至 improve-3，“第二批”对应 improve-4。每批目录下有 01 现状、02 方案与改动面、04 验收，简写。行为、视觉和组件以本目录 00–08 为准，各批文档只写“这一批改哪些、怎么验”。实施后各批另写 05 验收。

这里按用户要求用 `improve-N` 表示实施批次，保留现有四批结构。各批 01 中的代码事实以 `f5f36b9e` 为快照，“假设上一批已完成”属于前置目标；开工前要按实际代码复核，不把目标写成已完成事实。各批的 `05-implementation-acceptance.md` 记录本批结果，四批结束后再写根目录 `09-implementation-acceptance.md`，做整体行为和视觉验收。

## 实施约定（2026-10-23 审阅补充）

四批顺序保留。improve-1 内部先做行为不变的拆分，再做外壳和视觉；improve-2 先拆客户端和运行时，再接草稿、全局列表；improve-4 先完成设置错误协议，再接页面。每批在验收通过后提交，纯拆分与行为变化尽量分开提交。本次只提交设计文档，尚未开始前端实施。

用户已确认的范围补充：

- **附件先不做**：现有 Web 和 SDK 没有附件上传/发送链路，四批内隐藏输入框附件 `[+]`，后续单独规划上传能力（D22）。
- **MCP 只读**：用户通过对话让 ohbaby 修改 MCP 配置文件；Settings 用来查看全局配置、连接状态、失败原因和工具列表。移除原方案的 MCP 编辑表单、开关、增删和 Reconnect；配置与状态可用 Refresh 重新读取，刷新不触发重连（D25）。

模型表单中尚无清除协议的可选字段仍按 06 §2.2 的前端校验建议处理，不扩展后端协议；这不是 MCP 的待确认问题。MCP 只读后，原先关于 MCP 字段清空的讨论不再适用。

工程约束以 02 为准：`AppController` 负责业务接线，`AppShell` 负责布局；新状态按领域切片，不继续堆到现有 658 行的 `store.ts`。HTTP 错误要保留 `targetDirectory` / `fields`；运行中换项目保留本轮流与审批绑定，其他目录的行操作不切换当前 SSE。Settings 只退出旧配置写入口，保留思考强度依赖的 `GET /v1/model`。

参考截图没有作为图片文件随本目录入库。本次审阅核对了 pi-web 源码和已记录的视觉决策，未做三款 App 原图的逐图验收；实施时以 03 的线框与约束为依据，有原图时再并排校准。基线 `pnpm exec vitest run apps/ohbaby-web`：46 个测试文件、605 个用例通过；这是改造前基线，不代表重构已验收。

## 参考来源

| 来源 | 借鉴点 |
|---|---|
| Claude、Codex、Cursor 桌面端截图（2026-10-23 用户提供） | 中性偏暖白、侧栏深一档、轻玻璃、输入框卡片结构、居中空状态、行尾相对时间 |
| `code-cli/frontend/pi-web` | 两栏外壳、按项目分组的会话树、左下角设置入口、空状态输入框居中、语义色 token；设置页“分区内先列表、点进去看详情编辑”，env 和 header 只显示名字（`components/SettingsUi.tsx`、`docs/agents/mcp-settings.md`） |
| `code-cli/ZCode`（`DESIGN.md`） | 中性灰底、黑白主按钮、圆角按嵌套逐级递减、整页设置加左侧分组导航 |
| `code-cli/deepseek-harness` | 窄屏自动收起侧栏；输入框“左权限 / 右模型 + 发送”的分区思路 |
| Claude / Codex 桌面端截图 | 整体气质、侧栏与输入框的比例 |

## 相关文档

- [Web 架构](../architecture.md)、[UI 组件约定](../ui/components.md)：现有约定。本次改版落地后需要同步更新。
- [improve-1 方案](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/02-optimization-plan-and-change-scope.md)、[improve-1 验收](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/04-test-and-acceptance.md)：产品行为与 T18–T24 的验收依据。
- [improve-2 方案](../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-2/02-optimization-plan-and-change-scope.md)、[SDK 设置契约](../../../packages/ohbaby-sdk/src/contract/settings.ts)：设置接口与字段的依据。
