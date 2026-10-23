# improve-1 · 1. 现状

> 代码基线 `codex/redesign`（`f5f36b9e`）。路径相对 `apps/ohbaby-web/src/`，行数是 2026-10-23 的快照。

## 样式

- 样式入口 `ui/styles.css` 按固定顺序引入 16 个 CSS 文件，其中 `styles/overrides.css`（277 行）做跨功能覆盖，之后还有 `session/subagents.css`、`session/sidebar.css`，顺序依赖很强。
- 没有 CSS 变量：`styles/base.css` 直接写 `#fafafa`、`#26282d`，16 个 CSS 文件里有字面量颜色（最常见的是 `#ffffff`、`#8a8d94`、`#26282d`）。
- 字体是 IBM Plex Sans；思考中用三色波点；斜杠面板用金、粉、蓝分类色（`slashCommandAccent`、`.ohb-tool-blue` 等）。
- `ui/styles.unit.test.ts` 直接断言 CSS 内容，包括旧色值。

## 外壳与组件

- `ui/App.tsx`（137 行）在没有选中目录时渲染 `EmptyWorkspaceApp`（“Open a project to get started”）。
- 左侧是 `ui/workspace/ProjectRail.tsx`（174 行）的项目图标栏，侧栏是 `ui/session/SessionSidebar.tsx`（259 行），只显示当前目录的会话。
- 主区顶栏和字标在 `ui/session/SessionStatus.tsx`。
- 外壳在 `SessionScreen` 里面：`SessionScreen.tsx` 自己渲染 `ProjectRail`、`SessionSidebar`、`PermissionPolicyControl` 和 `DirectoryPickerDialog`（约 L932、942、1235、1281），`App.tsx`（L46）只在有 client 时挂载它。
- 没有通用的 Menu、IconButton、Spinner、Switch 组件；会话菜单是 `ui/session/SessionActionsMenu.tsx` 自己实现的。

## 大文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `ui/session/SessionScreen.tsx` | 1292 | 提交状态推导的纯函数（`selectPromptProjection` 等，约 230 行）加一个约 1000 行的组件：会话加载、提交、插话、审批、子代理、空态 |
| `ui/composer/Composer.tsx` | 1312 | 一个约 1200 行的组件：输入、IME、斜杠面板、插话排队、控制行、占位文字 |

## 和目标的差距

见 [00–08](../README.md)：需要 token、玻璃、两栏外壳、顶栏、卡片内控制行、新的消息与审批样式、少提示。数据流本批不动。
