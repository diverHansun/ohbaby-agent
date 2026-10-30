# 05 组件

> 层级规则见 [02 §5](02-frontend-architecture.md)。本文只列这次新增或明显改动的组件；没列出的现有组件（消息行、工具卡、斜杠命令面板、子代理视图等）只换样式，接口不变。

## 1. 分层与命名

| 层级 | 放在哪里 | 判定 |
|---|---|---|
| 基础组件 | `ui/shared/` | 不认识会话、工作区这些概念，换个产品也能用 |
| 组合组件 | 各功能目录 | 为某个场景组合基础组件 |
| 功能区 | `ui/shell`、`ui/sidebar`、`ui/search`、`ui/session`、`ui/settings` | 从 store 取数据、调用 runtime |

名字表达角色，不表达外观：`SessionRow` 而不是 `GrayRow`，`Wordmark` 而不是 `ColorText`。

## 2. 组件索引

| 组件 | 层级 | 职责 | 位置 | 状态 |
|---|---|---|---|---|
| `Menu` | 基础 | 弹出菜单：定位、键盘、过滤、焦点归还 | `ui/shared/` | 新增 |
| `IconButton` | 基础 | 只有图标的按钮，带可读名称 | `ui/shared/` | 新增 |
| `Spinner` | 基础 | 转圈 | `ui/shared/` | 新增（替换三色波点） |
| `Notice` / `NoticeStack` | 基础 | 对话区右上角的通知（失败、后台事件） | `ui/shared/` | 新增 |
| `Wordmark` | 基础 | 三色字标，`size: "sm" \| "md"`；`sm` 用于侧栏，`md` 只用于启动失败页 | `ui/shared/` | 由 `SessionStatus` 中的字标抽出 |
| `LycheeMark` | 基础 | Lychee 单色线性图标，`size`，颜色取 `--brand-lychee`（D26） | `ui/shared/` | 新增 |
| `AppController` | 功能区 | runtime 接线、视图切换、目录选择，向外壳提供区域内容 | `ui/shell/` | 新增 |
| `AppShell` | 组合 | 侧栏 + 主区布局、收起、窄屏抽屉 | `ui/shell/` | 新增 |
| `Sidebar` | 功能区 | 顶栏、会话树或搜索结果、底部设置入口 | `ui/sidebar/` | 改写自 `SessionSidebar` |
| `WorkspaceGroup` | 组合 | 工作区分组标题、折叠、Show more | `ui/sidebar/` | 新增 |
| `SessionRow` | 组合 | 会话行 | `ui/sidebar/` | 改写 |
| `SessionMenu` | 组合 | 会话菜单与工作区列表两级视图 | `ui/sidebar/` | 改写自 `SessionActionsMenu` |
| `SidebarSearch` | 功能区 | 搜索框、结果列表、分页 | `ui/search/` | 新增 |
| `MainHeader` | 组合 | 主区顶栏：侧栏开关、标题、目录、上下文用量 | `ui/shell/` | 改写自 `SessionStatus` 的顶栏部分 |
| `DraftHero` | 组合 | 草稿态的 Lychee 标识 + 工作区选择条 | `ui/session/` | 改写自空态 hero |
| `WorkspacePicker` | 组合 | 草稿里的工作区选择条和下拉 | `ui/composer/` | 新增 |
| `ComposerControls` | 组合 | 输入卡片内底部的控制行 | `ui/composer/` | 从 `Composer` 拆出 |
| `ApprovalPanel` | 组合 | 消息区内的审批浮层 | `ui/permissions/` | 改写自 `PermissionModal` |
| `SettingsDialog` | 功能区 | 设置弹窗：分区导航 + 分区内容 + 编辑子页切换，不进 URL（第二批，D2） | `ui/settings/` | 新增 |
| `SettingsNav` | 组合 | 设置弹窗左侧的分区导航 | `ui/settings/` | 新增 |
| `SettingsRow` | 基础 | “标签 \| 值或控件”一行，细线分隔；可点击时整行是按钮 | `ui/shared/` | 新增 |
| `ConfirmDialog` | 基础 | 确认框（标题、说明、确认和取消） | `ui/shared/` | 新增 |
| `SecretField` | 组合 | API key 字段：Configured / Not set、Replace、Clear、Add key | `ui/settings/` | 新增 |
| `ModelsSection` / `ModelEditor` | 功能区 / 组合 | 模型列表与编辑子页 | `ui/settings/` | 新增 |
| `McpSection` / `McpDetails` | 功能区 / 组合 | MCP 配置与状态列表、原地展开的只读详情 | `ui/settings/mcp/` | 新增 |
| `SearchSection`、`SkillsSection`、`AboutSection` | 功能区 | 单页表单与只读列表 | `ui/settings/` | 新增 |
| `ArchivedSection` | 功能区 | 已归档会话列表：自己分页，不进设置缓存；每行恢复或确认后永久删除（归档会话议题 D9） | `ui/settings/` | 新增 |
| `ModelMenu` | 组合 | 输入框控制行的模型菜单（第二批） | `ui/composer/` | 新增 |
| `ComposerMoreMenu` | 组合 | 手机（< 640px）控制行的“更多”：Thinking 二级列表和 Full access 开关，复用 `Menu`（improve-4 4b，D29） | `ui/composer/` | 新增 |
| `SidePanel` | 组合 | 右侧栏：Tab 栏、添加页面菜单、改宽把手、入口页、窄屏覆盖（D33） | `ui/side-panel/` | 新增 |
| `SubagentsPage` | 功能区 | Subagents 页：实例列表（Active/Done）和详情之间切换 | `ui/side-panel/subagents/` | 新增 |
| `SubagentInstanceList` / `SubagentInstanceDetail` | 组合 | 实例列表；实例详情（标题、状态、停止、只读消息流） | `ui/side-panel/subagents/` | 新增，消息流复用 `SubagentConversationBody` |
| `DelegationRow` | 组合 | agent 工具卡加一行入口：真正启动了子代理才显示，点击在右侧栏打开实例并定位；实例关闭后撤下 | `ui/session/` | 改写（improve-4） |
| `SubagentConversationBody` | 组合 | 子代理只读消息流和提示行，由右侧栏的详情使用 | `ui/session/` | 从已删除的 `SubagentView` 拆出 |
| `ConnectOverlay` | — | — | `ui/commands/` | 第二批删除（D18） |
| `ProjectRail` | — | — | `ui/workspace/` | 删除 |
| `TypewriterPlaceholder` | — | — | `ui/composer/` | 删除，占位改为固定文字 |

## 3. 关键组件契约

### Menu

- **Purpose**：所有弹出菜单的唯一实现，照 pi-web `SidebarMenu.tsx`。
- **Use when**：会话菜单、工作区菜单、工作区选择下拉、控制行里的模型 / 思考强度 / 权限模式选择。
- **Do not use when**：需要用户填写多个字段（用现有模态）；审批（用 `ApprovalPanel`）。
- **Anatomy**：可选的过滤框 / 条目（图标、文字、右侧快捷键或勾选）/ 分隔线 / 小标题。
- **States**：见 04 §1。
- **Visual semantics**：底色 `--bg`，描边 `--border`，菜单阴影；高亮 `--bg-hover`；危险项 `--danger`；勾选用 `--accent`。
- **API**（improve-1 实现）：
  - `anchor: MenuAnchor`（`x`、`y`、`aboveY`、`alignRight`；`anchorBelow(element)` 从按钮生成），放不下时自动向上或向左翻转
  - 条目是普通子元素：带 `role="menuitem"` 的按钮、`role="separator"` 分隔线。没有采用 `items: MenuItem[]` 数据形式：现有调用方只有两三个固定条目，直接写子元素更简单；需要数据驱动时再在调用方组装
  - `label`（无障碍名称）、`title?`（手机底部面板的标题，默认用 `label`）
  - `level?`：调用方原地切换二级列表时换一个值，焦点回到第一项；`onEscape?` 让 Esc 先返回上一级
  - `focusSelector?`：打开或换层时要聚焦的条目
  - `filterable?: boolean`（条目超过 8 个时由调用方打开）：顶部出现过滤框，按条目文字不区分大小写过滤，过滤时隐藏分隔线，没有结果时显示 `No matches`
  - `onClose(restoreFocus)`：Esc、Tab、Cancel 传 `true`，由调用方把焦点还给触发按钮；点外部传 `false`
- **手机（< 640px）**：自动变成底部弹出面板，带遮罩、标题行和 Cancel；条目行高 48、字号 15。过滤框不自动获得焦点，避免键盘盖住面板。
- **Accessibility**：`role="menu"` / `menuitem`（手机面板外层是 `role="dialog"`，里面是 `menu`）；↑↓、Home、End、Enter、Esc；有过滤文字时第一次 Esc 先清空；关闭后焦点回到触发元素。二级列表由调用方处理 Esc 返回，不能先触发整个菜单关闭。

### SessionRow

- **Purpose**：在侧栏表示一个会话，并作为打开和菜单的入口。
- **Use when**：侧栏会话树、Pinned 区。
- **Do not use when**：搜索结果（结构不同，由 `SidebarSearch` 自己渲染）。
- **Anatomy**：选中竖条 / 标题 / 行尾区域（awaiting 点、转圈或时间；hover 时换成归档和菜单按钮）。
- **States**：default、hover、selected、running、awaiting、menu-open、moving。
- **API**：
  - `session: SidebarSessionItem`（06 §2 的 ViewModel）
  - `selected: boolean`
  - `onOpen()`、`onArchive()`、`onOpenMenu(anchor)`
- **Accessibility**：行容器内，打开会话的主按钮与行尾操作按钮并列，禁止 button 嵌套 button；主按钮撑满剩余区域，名称是会话标题。行尾按钮各有名称（`Archive chat`、`More actions`）；running 和 awaiting 有 `aria-label` 文字，不只靠图形。

### SessionMenu

- **Purpose**：会话的置顶、移动工作区、导出、归档。
- **Anatomy**：第一级 `Pin/Unpin`、`Move to workspace…`、`Export…`、分隔线、`Archive`；第二级是工作区列表加 `Remove from workspace`，或导出格式 `HTML`、`JSONL`。
- **States**：main、workspaces、export、submitting。
- **API**：
  - `session: SidebarSessionItem`
  - `workspaces: readonly SidebarWorkspace[]`
  - `onTogglePin()`、`onArchive()`、`onMove(workspaceDirectory: string | null)`、`onExport(format)`、`onClose()`
- **Accessibility**：第二级里按 Esc 回到第一级，再按一次关闭。

### WorkspacePicker

- **Purpose**：在草稿里选择工作区。会话发出后不再使用。
- **Use when**：草稿态，输入框上方。
- **Do not use when**：已有会话换工作区（用 `SessionMenu`）。
- **States**：no-workspace、selected、open。
- **API**：
  - `value: string | null`（工作区目录，`null` 表示 No workspace）
  - `workspaces: readonly SidebarWorkspace[]`
  - `onChange(directory: string | null)`、`onOpenFolder()`
- **行为**：选择或更换都不影响输入框文字。

### ComposerControls

- **Purpose**：输入卡片内底部的一行控制按钮（D22）。
- **Anatomy**：顺序以 D22 和 03 §4.3 为准：左边权限模式；右边模型、思考强度、圆形发送。附件入口的范围见 README 的实施约定。
- **API**：接收现有 `ReasoningControl`、`PermissionPolicyControl` 需要的数据与回调，加上 `running`、`onStop()`；模型按钮第一批沿用现有 `modelLabel`、`onOpenModel()`，第二批换成 `ModelMenu`。
- **约束**：选择控件为无边框文字按钮；发送和 Stop 都是深色圆形按钮（D32）。沿用现有提交规则：运行中且草稿为空时主位是 Stop，有草稿时仍能发送插话或排队；不增加第二套 Send/Stop 状态机。手机（< 640px）次要项收进“更多”菜单；按 D29 放在 improve-4，与模型菜单一起实现。

### ApprovalPanel

- **Purpose**：在消息区内处理工具审批，不盖住整页。
- **Use when**：当前会话有待处理的审批请求。
- **States**：expanded、collapsed、responding、multiple（`1 / N` 翻页）、syncing、sync-error（见 04 §1）。
- **API**：沿用 `PermissionModal` 现有的 props，包括后端返回的选项列表、多请求翻页、同步状态与 Retry、Stop run；只增加 `collapsed`、`onToggleCollapsed()`。
- **Accessibility**：出现时焦点移到第一个选项按钮；`role="dialog"`、`aria-modal="false"`；Esc 不作用于它（04 §3）。

### MainHeader

- **Purpose**：主区顶栏。
- **API**：`title?`、`workingDirectory?`、`contextUsage?`、`archived?`、`sidebarCollapsed`、`onToggleSidebar()`、`onOpenContextUsage()`。
- **约束**：不显示连接状态（README 的 D6）；草稿态只有侧栏开关。

### ModelMenu（第二批）

- **Purpose**：在输入框卡片底部的控制行里给当前会话选模型（D15，2026-10-26 改为会话级）。不改全局默认。
- **Anatomy**：触发按钮显示这个会话下一轮要用的模型：会话选过且条目仍完整时是它，否则是默认模型；都没有时显示 `Choose model`。菜单按 provider 分组，每项是“模型名 + 备注”，勾打在下一轮要用的那一项上，默认模型旁有一个不显眼的 `default` 标记；最后一项 `Manage models…`。不加说明文字。桌面弹出菜单的模型列表限高滚动，`Manage models…` 固定在列表下方；手机底部面板整体滚动。打开时把打勾的一项滚到中间。
- **API**：`settings`（读共享的模型列表缓存，只列配置完整的条目）、`selectedEntryId?`（会话或草稿自己的选择，跟随默认时为空）、`onSelect(id)`、`onManage()`、`onError(error)`。已打开的会话里 `onSelect` 调 `updateSessionModel`；草稿里只记在内存，第一条消息带上 `modelEntryId`。
- **States**：default / open / selecting（触发按钮转圈）/ error（右上角通知，按钮恢复原来的模型）。跟随默认的会话点默认模型也会把它固定到这个会话上。

### SecretField

- **Purpose**：统一 API key 的显示与修改，保证页面不出现 key 原文。
- **API**：`configured: boolean`、`value: SecretChange`（`keep` / `{ replace: string }` / `clear`），`onChange(next)`。
- **映射**（06 §2.2）：`keep` 不传 `apiKey`；`replace` 传新值；`clear` 传空字符串。后端里清除 key 和无 key 模式是同一回事，所以没有单独的 No API key 选项。
- **约束**：输入框是 `type="password"`、`autocomplete="off"`；保存成功后清空。

### McpDetails

- **Purpose**：查看一台全局 MCP 服务器的配置、实际连接状态和工具列表。
- **Anatomy**：在对应行下展开，配置按标签和值排成行，状态、失败原因和 Tools 独立展示；可选字段没有值时不显示。
- **API**：接收只读配置 ViewModel 与当前实例的状态、工具列表，不接收保存、删除、启停或重连回调。
- **约束**：Environment / Headers 只显示名字，URL 使用服务端脱敏结果；没有表单或开关。刷新由 `McpSection` 触发，只重读配置与状态。配置修改继续交给 ohbaby（D25）。

### SidePanel

- 输入：`useSidePanel` 给出的状态（`open`、`width`、`expanded`、`tabs`、`activeTabId`）和操作（打开、关闭、展开、改宽、开页面、切换、关闭 Tab、改页面状态）；每个 Tab 怎么渲染由调用方传入。
- Tab 是 `{ id, kind, state }`，`state` 的类型由页面种类决定。`openPage(kind, state?)` 新开一个 Tab 并直接打开到某个状态。`revealPage(kind, state)` 给别处的入口用：当前 Tab 是这种页面就复用它，否则用第一个同类 Tab，都没有才新开，然后替换它的状态。主会话的入口行用它打开某个实例的详情（improve-4）。
- **页面登记（为文件预览、终端、内置浏览器、Side chat 留位置，D34）：**
  - 加一种页面只改三处：`side-pages.ts` 里的 `SidePageStates` 加这种页面的状态类型；`SIDE_PAGES` 里登记标题、图标、一句说明、初始状态，以及是否跟会话走（`sessionScoped`）；`SidePanelPage` 里加一个渲染分支。
  - Tab 栏、添加菜单、入口页都从登记表生成，容器本身不用改。
  - 跟会话走的页面（Subagents）在切换主会话时回到初始状态，终端、浏览器这类不受影响。页面要的外部依赖都通过 `SidePageContext` 传进去。
- Tab 状态只在前端内存里（D46）。刷新页面后只恢复 `open` 和 `width`（localStorage，窄屏不记），不恢复 Tab，也不恢复展开。
- 同一种页面可以开多个 Tab（D36）。收起时保留 Tab 状态（包括 Subagents 页选中的实例），但页面会卸载；关闭 Tab 也会卸载页面。页面卸载时只释放读取，不调用任何 agent 的 stop 或 close。

### SubagentsPage

- 输入：`client`、`rootSessionId`、会话层共用的实例快照 `instances`（`useSubagentInstances`），以及可选的 `anchor`（主会话入口行的定位请求）。会话变化时整页重建，旧会话的读取全部释放。
- 实例快照由 `AppController` 用 SDK 的 `createSubagentInstanceReader` 读一份，右侧栏列表和主会话入口行共用；只传 `rootSessionId`，绑定由 client 注入。收到失效事件、`session.resync-required`，或停止之后，都刷新一次。快照里没有的实例算已关闭，读取失败不算。
- 分组只在前端推导：Active 是 `pending`、`running`，或 `settling`、`approvalBlocked` 为真；其余是 Done。
- 详情用 SDK 的 conversation reader，由页面持有：回到列表时保留，再打开同一个实例就沿用已加载的内容和阅读位置，只在第一次打开、或主会话入口行明确要求定位时按锚点定位；实例离开快照（被关闭）时释放。服务端每个客户端只保留一个子代理订阅；Subagents 页是唯一持有阅读器的地方，右侧栏也只渲染当前 Tab，所以同一时刻最多一个订阅。
- 从顶栏打开右侧栏时，焦点移到选中的 Tab 或入口页第一项；刷新后自动恢复打开时不抢焦点。
- 在 SDK 能按 `subagentId` 直接打开之前（improve-2 B4），打开时先取一次执行记录再交给 reader：入口行给了 `executionId` 就用它，否则用实例的 `latestExecutionId`。
- 停止调用 `stopSubagent`，带上实例当前的 `currentExecutionId`。错误码 `SUBAGENT_SNAPSHOT_CHANGED`（HTTP 409）当成“已提交，结果不确定”，刷新列表后以列表为准；其他 409（比如跨会话）照常报错。

## 4. 组件与模式

以下是“模式”，由多个组件组合实现，不做成一个大组件：

- **草稿首发**：`DraftHero` + `WorkspacePicker` + `Composer`，由 `SessionScreen` 组合。
- **侧栏搜索切换**：`Sidebar` 根据搜索框是否有内容，在会话树和 `SidebarSearch` 之间切换。
- **撤销提示**：不做。服务端没有取消归档的接口；归档后行直接消失，不另外提示（D16）。
- **列表加编辑子页**：`ModelsSection` + `ModelEditor` 由设置弹窗按内存里的状态切换，不进 URL；编辑子页返回所属列表，× 或 Esc 关闭整个弹窗。
- **只读列表与详情**：`McpSection` + `McpDetails`，详情原地展开，展开状态留在组件内，不新增编辑路由。
