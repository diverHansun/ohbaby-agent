# improve-1 · 2. 方案与改动面：视觉基础与外壳

> 依据：[03](../03-ui-layout-and-style.md)（视觉、线框、token）、[05](../05-components.md)（组件）、[02 §3.1](../02-frontend-architecture.md)（拆分原则、CSS 位置）。现状见 [01](01-current-state.md)，验收见 [04](04-test-and-acceptance.md)。

## 目标

换上新的视觉体系和两栏外壳，并把两个大组件拆开。**数据流不变**：仍然是“选一个目录 → 一个实例”，侧栏仍只列当前目录的会话。改完后整个应用可以照常使用。

## 步骤

按顺序做，每一步结束时现有测试都要通过。

1. **拆大文件**（只拆不改，行为不变）：

| 原文件 | 拆成 |
|---|---|
| `ui/session/SessionScreen.tsx` | `prompt-projection.ts`（提交状态推导的纯函数）、`useSessionLoad.ts`（会话加载、历史、恢复）、`usePromptSubmission.ts`（提交、插话、尝试与错误）、`useSessionInteractions.ts`（审批、子代理）、`SessionScreen.tsx`（组合） |
| `ui/composer/Composer.tsx` | `Composer.tsx`（组合）、`ComposerInput.tsx`（输入、IME、快捷键）、`useComposerDraft.ts`（草稿持久化与 `composerDraftKey`、`composerLeaseKey` 租约）、`useSteerQueue.ts`（插话与排队）、`useSlashPalette.ts`（斜杠面板的接线）、`ComposerControls.tsx`（控制行） |

   每个文件以不超过约 400 行为目标；纯逻辑放 `.ts`，不依赖 React。

2. **把外壳提出 `SessionScreen`**：现在 `SessionScreen.tsx` 自己渲染 `ProjectRail`、`SessionSidebar`、`PermissionPolicyControl` 和 `DirectoryPickerDialog`（约 L932、942、1235、1281），`App.tsx` 只在有 client 时挂载它。改为：`ui/shell/AppController.tsx` 从 runtime 取目录和会话数据，组合侧栏、主区和目录选择对话框；`AppShell.tsx` 只接收区域插槽，负责布局和侧栏开合。`SessionScreen` 只负责对话视图。`App.tsx` 挂载 `AppController`，删除 `EmptyWorkspaceApp`；不把原大组件的业务一起搬进布局文件。

3. **token 与全局样式**：新增 `ui/styles/tokens.css`（03 §3）。`styles.css` 的引入顺序改为 tokens → base → shared → 各功能；各功能的 CSS 放在功能目录里（`shell/shell.css`、`sidebar/sidebar.css` 等），`styles/empty-state.css`、`conversation-layout.css` 迁入对应功能，删除 `styles/overrides.css`。字体换成系统字体加 JetBrains Mono；去掉三色波点、回弹动画，斜杠面板的金粉蓝分类色改为中性色（D5）。

4. **基础组件**（`ui/shared/`）：`Menu`（参考 pi-web `components/SidebarMenu.tsx` 的定位和键盘逻辑，自己写成小文件，带单测）、`IconButton`、`Spinner`、`Notice` / `NoticeStack`、`Wordmark`。`Switch` 随 improve-4 的第一个真实使用者加入，避免先造空闲组件。

5. **外壳与侧栏**：
   - `AppShell`：两栏、收起、窄屏抽屉；断开提示由 `AppController` 提供。
   - `MainHeader`：由 `SessionStatus` 的顶栏部分改写，玻璃顶栏，标题、工作目录、上下文用量（70%、90% 变色）。字标移到侧栏顶部，`SessionStatus` 不再保留。
   - 临时侧栏：把 `ProjectRail` 的项目切换并入侧栏，做成 Projects 分组：当前目录展开显示会话，其他项目折叠，点击切换目录（沿用现有逻辑）。按目标结构写 `ProjectGroup`、`SessionRow`，improve-2 只换数据来源。删除 `ProjectRail`。
   - `SessionActionsMenu` 换肤并改用通用 `Menu`，功能不变（improve-3 再改写）。

6. **对话视图与输入框**：
   - 消息、过程折叠行、工具行换肤；`ApprovalPanel`（由 `PermissionModal` 改写）浮在消息区内、可折叠、多请求翻页。其他会话行上的琥珀点需要全局数据，放在 improve-2。
   - 输入框卡片内底部控制行（D22）：左侧 `PermissionPolicyControl`，右侧模型按钮（沿用现有 `/connect` 行为）、`ReasoningControl` 和圆形发送；删除 `TypewriterPlaceholder`。当前没有附件上传和发送契约，本批先隐藏附件入口，见 README。
   - 卡片上方的项目选择条在本批只留位置，显示当前目录名，不做下拉；真正的 `ProjectPicker` 在 improve-2。
   - 空态（D23）：字标 + 选择条位置 + 输入框卡片居中。**没有打开任何目录时**，选择条位置显示 `Open folder…`，点发送也打开目录选择（本批没有默认工作区的草稿首发，improve-2 再改成直接发送）。目录选择前后的输入放在稳定的草稿容器中保留；没有 client 时隐藏依赖实例的模型、思考与权限控件，不能访问空 client 或伪装成离线。

7. **少提示**（D16）：没配模型时不显示提示，点发送才打开 `/connect` 浮层；不显示后端说明性通知，在 Web 的通知入口（`store/store.ts` 接收 notice 的位置）按 key 过滤掉 `runtime:model-switch`。

不做：全局会话列表、草稿首发、项目归属菜单、搜索、设置页（improve-2 至 4）；不改 `api/daemon` 和 `runtime.ts`。

本批不显示尚无功能的 Search、Settings 按钮；分别在 improve-3、improve-4 接通后出现。Mock 随本批提供 `running` 和当前行为下的空态/侧栏样例，improve-2 再升级为最终草稿与全局数据场景。每一步可回退，建议把纯拆分和视觉变更分别提交。

## 改动面

| 目录 | 新增 | 修改 | 删除 |
|---|---|---|---|
| `ui/styles/` | `tokens.css` | `base.css`、`styles.css` 入口顺序 | `overrides.css`；`empty-state.css`、`conversation-layout.css` 迁走 |
| `ui/shared/` | 步骤 4 的组件及其 CSS | `ContextUsage` 换肤 | — |
| `ui/shell/` | `AppController`、`AppShell`、`MainHeader`、`shell.css` | — | — |
| `ui/session/` | 步骤 1 拆出的文件 | `SessionScreen`（只剩对话视图）、`SessionSidebar`、`SessionRow`、`SessionActionsMenu` 换肤 | `SessionStatus`（由 `MainHeader` 取代） |
| `ui/composer/` | 步骤 1 拆出的文件 | `composer.css`、`controls.css` | `TypewriterPlaceholder` |
| `ui/permissions/` | `ApprovalPanel` | `PermissionPolicyControl`、`policy.css`（移入卡片） | `PermissionModal` |
| `ui/commands/` | — | 斜杠面板分类色 | — |
| `ui/workspace/` | — | `directory-picker` 换肤 | `ProjectRail` |
| `ui/App.tsx`、`store/store.ts` | — | 挂载 `AppController`；notice 过滤 | `EmptyWorkspaceApp` |

## 风险

| 风险 | 应对 |
|---|---|
| 拆分时改坏提交、插话、审批、草稿租约 | 步骤 1 只拆不改；2026-10-23 基线为 46 个测试文件、605 个用例，全部通过后再进入步骤 2 |
| 把侧栏提出 `SessionScreen` 牵动 client 生命周期 | `AppController` 读取 runtime 快照，切换仍走现有 `switchWorkspace`；`AppShell` 不管理 client；`workspace-switch` 等集成测试覆盖 |
| 玻璃效果影响对比度或性能 | 只用在浮起元素上；文字按最不利背景核对；`backdrop-filter` 不支持时退回实底 |
| 临时侧栏到 improve-2 又要改 | 组件按目标结构写，improve-2 只换数据来源 |
