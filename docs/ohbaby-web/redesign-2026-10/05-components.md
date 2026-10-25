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
| `ModelMenu` | 组合 | 输入框控制行的模型菜单（第二批） | `ui/composer/` | 新增 |
| `ComposerMoreMenu` | 组合 | 手机（< 640px）控制行的“更多”：Thinking 二级列表和 Full access 开关，复用 `Menu`（improve-4 4b，D29） | `ui/composer/` | 新增 |
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

- **Purpose**：在输入框卡片底部的控制行里直接选择全局默认模型（D22）。
- **Anatomy**：触发按钮显示当前默认模型名（没有默认时显示 `Choose model`）；菜单按 provider 分组，每项是“模型名 + 备注”，当前项有勾；最后一项 `Manage models…`。不加说明文字（D15）。
- **API**：`models: SettingsModelOption[]`（06 §2.2，只含配置完整的条目）、`activeId: string | null`、`onSelect(id)`、`onManage()`。
- **States**：default / open / selecting（触发按钮转圈）/ error（右上角通知，菜单恢复原选择）。

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

## 4. 组件与模式

以下是“模式”，由多个组件组合实现，不做成一个大组件：

- **草稿首发**：`DraftHero` + `WorkspacePicker` + `Composer`，由 `SessionScreen` 组合。
- **侧栏搜索切换**：`Sidebar` 根据搜索框是否有内容，在会话树和 `SidebarSearch` 之间切换。
- **撤销提示**：不做。服务端没有取消归档的接口；归档后行直接消失，不另外提示（D16）。
- **列表加编辑子页**：`ModelsSection` + `ModelEditor` 由设置弹窗按内存里的状态切换，不进 URL；编辑子页返回所属列表，× 或 Esc 关闭整个弹窗。
- **只读列表与详情**：`McpSection` + `McpDetails`，详情原地展开，展开状态留在组件内，不新增编辑路由。
