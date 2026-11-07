# 消息复制

本议题于 2026-11-04 开启。目标是让 Web 上的用户消息、AI 的最终答案和代码块都能一键复制，复制的内容只有正文，不带思考过程和工具执行过程。

本议题只改 Web，TUI 不新增复制命令。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | Web 消息操作栏、剪贴板工具、用户消息与最终答案复制、代码块复制 | 已实施，待用户验收（2026-11-06，分支 `codex/message-copy`） |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | Web 消息渲染、最终答案判定、剪贴板、Markdown 渲染的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 2、改动面、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | deepseek-harness、ZCode、kimi-code、opencode 的复制做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## 实施记录（2026-11-06）

在分支 `codex/message-copy` 上实施，没有合并或推送。只改 Web，后端、SDK、TUI 都没动。界面参考 Claude、Codex、Cursor 的做法；这几个桌面应用不在 `code-cli/` 下，参考的是产品的实际表现。

**落地内容**：

- `ui/shared/clipboard.ts` 的 `writeClipboard`：先用 `navigator.clipboard`，不可用或被拒绝时退回隐藏 `textarea` 加 `execCommand("copy")`，返回是否成功。
- `ui/shared/CopyButton.tsx`：全站唯一的复制按钮，成功显示对勾，失败显示 `Copy failed`。About 设置和 Files 预览原来各有一份私有实现，都换成了它。
- `ui/conversation/MessageActions.tsx` 与 `message-text.ts`：用户消息（含 steer）和每轮最终答案下面的操作栏，只复制 `text` 片段。
- `ui/shared/MarkdownBlock.tsx`：模块内的 `Marked` 实例给每个代码块加 `Copy` 按钮，容器统一处理点击。

**收尾（2026-11-07）**：和[轮次投影议题](../2026-11-06-turn-projection/README.md)的前端部分一起完成。子代理叫醒的轮次也有自己的答案和复制按钮。失败或被停止的轮次，只要最后一条 AI 消息里有文字，也能复制；停止时追加的中断提示（`lifecycle-interruption`）不会被复制。

**与 02 的三处出入**（实施时决定，请审查）：

| 项 | 02 原文 | 实际 | 理由 |
|---|---|---|---|
| 代码块按钮的位置 | 插在 `<pre>` 开头 | 用 `<div class="ohb-code-block">` 包住按钮和 `<pre>`，按钮是 `<pre>` 的兄弟节点 | 按钮在 `<pre>` 里会随长代码横向滚走；放在外层才能固定在右上角，复制时也不会把按钮文字带进去 |
| 代码块底色 | 未提 | 聊天里的 Markdown 代码块加了浅灰底（`--bg-panel`、圆角 8）；Files 预览原有的同类样式删掉，改用这一份 | 原来的代码块没有底色，角上的按钮会浮在文字上；Claude、Codex、Cursor 的代码块都有底色 |
| 最新答案的操作栏 | 悬停或聚焦时显示 | 最新一条答案的操作栏一直显示，其余照旧 | 照 Claude 的做法；用户最常复制的是刚得到的回答 |

另外，在触屏设备上代码块的 `Copy` 按钮一直显示，所以给代码留出顶部一条空间，免得挡住第一行代码。

**审查后的修正**（子代理审查发现一项阻塞问题和几项应修问题，都已修复）：

- 阻塞项：模型输出里的原始 HTML 能伪造代码块，显示一条命令、复制另一条。已改为按钮带随机令牌，只复制渲染器包装层直属的 `<pre>`，并补了测试（见 04 §4.5）。
- iOS Safari 在只读的 `textarea` 里选不中文字，退回复制方式去掉了只读，并补上 `setSelectionRange`。没有真机验证。
- 代码块按钮的读屏名称会随结果变成 `Copied` 或 `Copy failed`；按钮文字不会被拖选进复制内容。
- 连续点击复制会重新计时；About、Files 预览的复制失败也显示错误色；用户气泡里的代码块改用页面底色，免得看不出来。
- 运行中，或最新一轮没有最终答案时，不保留常显的操作栏。

**已知限制**：右侧栏的子代理详情不传 prompt 记录，算不出“最终答案”，所以那里只有父代理派来的任务消息能复制，子代理自己的回答没有复制按钮。要补的话需要子代理视图提供轮次信息，留到以后。

**验证**：Web 全部测试通过；用隔离的 daemon 加脚本模型在内置浏览器走查了 T4 到 T7、T9、T10（宽屏和 375px 手机宽度），复制结果用页面内的剪贴板记录核对过。T8（局域网 `http://`）没有实际环境，降级逻辑由 T2 的单元测试覆盖。

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 本议题没有要求关键改动清单，02 只写到包和文件一级。
- 分工在实施前与用户确认。

## 相关议题

同一批（2026-11-04）还有四个议题，各自独立成册：

| 议题 | 关系 |
|---|---|
| [撤销重发](../2026-11-04-conversation-undo/README.md) | 它的 Edit 按钮挂在本议题搭好的消息操作栏上，应在本议题之后实施 |
| [会话 fork](../2026-11-04-session-fork/README.md) | 它的 fork 按钮挂在本议题的消息操作栏上 |
| [side chat](../2026-11-04-side-chat/README.md) | side chat 面板沿用本议题的 `MessageActions` 复制按钮，它的 Web 部分应在本议题 Stage 1 之后实施 |
| 会话存储区（`docs/services/session-storage/`） | 无直接依赖 |
