# 消息复制

本议题于 2026-11-04 开启。目标是让 Web 上的用户消息、AI 的最终答案和代码块都能一键复制，复制的内容只有正文，不带思考过程和工具执行过程。

本议题只做 Web 的复制，TUI 不新增复制命令。improve-1 只改 Web；improve-2 为修正最终答案的判定，将在后端投影和 SDK 契约上各改一处。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-04 | 首轮 | Web 消息操作栏、剪贴板工具、用户消息与最终答案复制、代码块复制 | 已实施并合入 `main`；用户验收时发现两处漏网，转入 improve-2 |
| [improve-2](improve-2/00-discussion.md) | 2026-11-07 | 复发返修：用户验收 improve-1 时发现两处漏网 | 长会话旧答复丢失复制按钮；隐藏工具后中断，阶段说明被当成最终答案 | 已实施，待用户审查（2026-11-07，分支 `codex/copy-improve-2`） |

## improve-1 文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定、边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | Web 消息渲染、最终答案判定、剪贴板、Markdown 渲染的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 2、改动面、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | deepseek-harness、ZCode、kimi-code、opencode 的复制做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 场景、回归清单、发布门 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-1/05-implementation-acceptance.md` |

## improve-2 文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-2/00-discussion.md) | 两个问题的修法、放弃的选项、不在本轮的事项 |
| [01 现状与问题分析](improve-2/01-problem-analysis-and-current-state.md) | Web store 的三份缓存、后端窗口如何裁掉 run 和 prompt、隐藏工具在哪里丢掉、已有测试的缺口 |
| [02 方案与改动面](improve-2/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1（Web 缓存 run 和 prompt）、Stage 2（隐藏工具留标记）、兼容与风险 |
| [03 参考项目](improve-2/03-reference-projects.md) | codex、deepseek-harness、kimi-code、ZCode 怎么隐藏工具、怎么判定最终答案 |
| [04 测试与验收](improve-2/04-test-and-acceptance.md) | 成对回归、浏览器走查、发布门 |
| 05 实施验收 | 实施完成后由验收会话写入 `improve-2/05-implementation-acceptance.md` |

## improve-1 实施记录（2026-11-06）

在分支 `codex/message-copy` 上实施，当时没有合并或推送；后来并入 `main`（2026-11-07 的 `c0c24b4f` 已包含）。只改 Web，后端、SDK、TUI 都没动。界面参考 Claude、Codex、Cursor 的做法；这几个桌面应用不在 `code-cli/` 下，参考的是产品的实际表现。

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

## improve-2 实施记录（2026-11-07）

在分支 `codex/copy-improve-2` 上实施，没有合并或推送。按 02 的两个 Stage 分批提交：

| 提交 | 内容 |
|---|---|
| `0db3a9df` | 规划文档 |
| `4292be70` | Stage 1：Web store 缓存已结束的 run 和 prompt，只取仍被显示中的消息引用的副本 |
| `b6c87f70` | Stage 2 后端：`UiMessage.hiddenToolCalls`，`messageToUiMessage` 删掉隐藏工具片段时打上；SQLite 重开前后的成对回归 |
| `b2cae380` | Stage 2 Web：判定答案时排除带标记的步骤；同步 `docs/tools/todo-list/architecture.md` |

**与 02 的出入**：无。`installSessionHistory` 原来对 prompt 的筛选和比较抽成了 `rememberPrompt`，实时视图和历史页共用；run 对应 `rememberRun`。

**自动化测试**：新增的 T1、T2、T4、T5、T6、T8 去掉修复后都会失败，加上修复后通过；T3、T7 守护已有行为。全量运行通过 4,988 项单元测试、581 项契约测试、2,135 项集成测试，另有 2 项单元测试跳过；类型检查通过，lint 报告 0 个错误。轮次投影 T13 的已有用例里，历史页消息补上了 `runId`，与真实数据一致（历史页带回的 run 一定被本页消息引用）。

**浏览器走查**：用隔离的 daemon（独立数据目录）加脚本模型，编译后的 CLI 和 Web，在内置浏览器里按 04 §4.4 走查。

- T12：子代理唤醒的收尾答复 `WINDOW_A_VISIBLE_50`、普通轮次的答复 `USER_ANSWER_A` 之后，一条 `E2E-BASIC` 消息让模型连走 55 步工具调用。新开标签页确认这两条答复已不在服务端最近 50 条里；原页面上两条答复的 `Copy answer` 都在，`Subagent update` 耗时行也在，复制结果分别正好是这两段正文。
- T13：模型先写 `I will check the private task list.`，再调用 `todo_read`。确认工具结果已写盘后用 SIGKILL 结束 daemon，再用同一数据库重启：页面显示 `interrupted`，悬停这句阶段说明也没有 `Copy answer`。同样的位置改为在页面上点 Stop、不重启，结果相同。对照组纯正文流到一半点 Stop，仍有按钮，复制结果是 `Half of the plain answer`，不含中断提示。
- T11：新标签页点 `Load earlier messages` 后，较早轮次的复制按钮和 `Subagent update` 都在。
- T10：Web 上看不到 `todo_read` 的工具卡片。TUI 这部分没有实际打开终端检查；本轮没有改 TUI 代码。

走查用的脚本只放在会话的临时目录里，没有进仓库。

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
