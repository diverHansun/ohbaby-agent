# improve-2 · 列表空组与详情页样式

> 2026-11-24 与用户讨论确定。小批次，现状、决定、改动面、验收合写在这一篇。路径相对 `apps/ohbaby-web/src/`，SDK 路径相对仓库根目录。

## 现状

- 没有运行中的任务时，列表仍然显示 `Running 0`、折叠箭头和一行 `None`，把 Done 组往下挤。Subagents 页的空组写法相同。
- 列表行里标题和命令只隔 3px，两行挤在一起。
- 被取消的任务在列表里只显示时长，和正常完成的任务看不出区别。
- 详情页的输出区是一整块左右贴边的灰底，一直铺到面板底部。没有输出时只剩一大片空灰底，左上角一行 `No output.`。
- 详情页的命令夹在状态行下面，用灰色等宽字，看不出是一条可以执行的命令；上半部分白底、下半部分灰底，交界是一条硬边。

参考项目（2026-11-24 由子代理核实）：ZCode、kimi-code、dsh、opencode 都不在空组里写 `None`，要么隐藏整个区块，要么不显示该组标题。kimi-code、dsh、opencode 的输出区都是离面板边缘有一段距离的圆角浅底块；kimi-code 和 dsh 把命令写成 `$ 命令`，放在这块的顶部。

## 决定

| 编号 | 决定 |
| --- | --- |
| B1 | 组空了就不显示：Running 或 Done 没有任务时，整组（标题、箭头、`None`）都不渲染。Subagents 页同样处理。两组都空时仍显示原来的空态文案。 |
| B2 | 列表行的标题和命令之间的间距从 3px 加到 6px，Subagents 页的行同样调整。 |
| B3 | 被取消的任务在列表右侧显示灰字 `Cancelled`，代替时长。规则在 SDK 的 `taskTrailing` 里，Web 和 TUI 共用，所以 TUI 同步变化。清理未确认（`Unconfirmed`）仍然优先。 |
| B4 | 详情页的输出区改成嵌入式命令块：离面板左右和底部留出间距，圆角，`--bg-subtle` 底色，不加边框和阴影。块的顶部是 `$ 命令` 和复制按钮，下面一条细分隔线，再下面是输出。块的高度跟着内容走，内容多时撑到面板底部，再在块内滚动。 |
| B5 | 命令着色：复用审批卡片的 `tokenizeShell` 和 `--syntax-*` 颜色，命令名、字符串、变量、参数和操作符的颜色与审批卡片一致。详情页命令块和列表行里的命令都着色。 |
| B6 | 不做卡片：列表行仍然是无边框的文字行；命令块只靠浅底和圆角区分，不加边框、阴影。 |
| B7 | 标题区只留返回、标题、Cancel 和状态行；命令从标题区移进命令块。空输出、未保存输出、只显示最后 32 KB 等说明放在命令块里，用界面字体。输出区顶部的渐隐只在往下滚过以后才出现，不再淡化第一行。 |

讨论过但不做：详情页状态行前加转圈（用户未采纳，维持 D3 的克制写法）。`Cancel` 文字按钮保持 D2 不变。

## 改动面

- `ui/side-panel/background-tasks/BackgroundTaskList.tsx`、`BackgroundTaskDetail.tsx`、`background-tasks.css`。
- `ui/side-panel/subagents/SubagentInstanceList.tsx`、`subagents-page.css`。
- `ui/permissions/shell-tokens.ts` 及其测试移到 `ui/shared/`；新增 `ui/shared/ShellTokens.tsx` 渲染着色后的命令；`.ohb-sh-*` 样式从 `permissions.css` 移到 `shared/shared.css`；`ApprovalPanel.tsx` 改用共享组件。
- `packages/ohbaby-sdk/src/util/shell-job-view.ts`：`taskTrailing` 新增 `cancelled`。
- 测试：SDK 的 `taskTrailing` 单测；Web 的后台任务页和 Subagents 页集成测试（空组不渲染、`Cancelled`、命令块）。

## 验收

1. 没有运行中的任务时，列表从 `Done N` 开始，看不到 `Running 0` 和 `None`；只有运行中的任务时，看不到 Done 组。Subagents 页一样。
2. 列表行的标题和命令之间有明显的呼吸感，不再挤在一起。
3. 被取消的任务在列表右侧显示灰字 `Cancelled`；失败、超时仍然是红字。
4. 详情页：命令块离面板边缘有间距、圆角、无边框；顶部是着色的 `$ 命令` 和复制按钮。没有输出的任务，命令块只有命令行和一行 `No output`，下面是白色面板，不再有一大片灰底。
5. 输出多时命令块撑满剩余高度并在块内滚动，跟随最新输出、回到底部按钮照常工作；没往下滚时第一行不被淡化。
6. 审批卡片的命令着色不变。
7. Web、SDK、TUI 相关测试和类型检查通过。
