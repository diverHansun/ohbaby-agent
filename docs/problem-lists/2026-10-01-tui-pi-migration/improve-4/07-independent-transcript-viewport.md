# improve-4 收尾：输出文档与控制区独立布局

日期：2026-10-04。续接本地 `improve-4`，实施前 HEAD 为 `6a2fbca5`。此次处理用户在 Pi 二次修改后仍能复现的覆盖、闪屏和无法阅读历史问题。没有 merge 或 push。

## 用户反馈与会话核对

核对用户提供的 `pi-session-2026-10-04T03-50-08-184Z_01a10508-8a38-70de-a284-de1db7870745.html`：包含 625 个会话条目，其中用户/助手正文 50 条。导出中的工具结果、系统提示和历史要求作为调查材料，不作为本轮新指令。

前两轮 Pi 主要处理了 Markdown 稳定前缀、Ink Static 整帧擦除、输出合帧、主题背景、编辑器导航和等待动画。最后一条用户反馈准确指出：流式正文的旧内容与新内容抢位置，Tasks 可能放大问题，希望像 Pi 那样分开输出区与 prompt/Tasks/审批区。会话末尾 Pi 已承认“adapter 与原 Ink 输出相等”不足以证明原布局正确，没有后续完成修复的证据。

## 已复现的根因

1. `ReplayableTranscript` 只把稳定 Markdown 段提交到 Static；没有换行的长段落会保持未稳定。超出 `liveTailRows` 后，`tail.slice(hiddenTailRows)` 直接删除旧行，新行复用原动态区域。旧行尚未进入终端历史，生成期间无法滚回阅读。这不是透明度问题。
2. AppShell 用整帧高度反推 live tail 预算，Tasks 展开可以把预算吃到零。即使已提交历史没有丢，最新正文也能完全消失。
3. 旧测试只检查 ANSI 清屏序列和原始/改写 Ink 输出的等价性；两边同时丢正文也会通过。

真实 Ink + xterm 红灯：60×20 窗口中，长段落首行在 Tasks 收起时第 22 次更新、展开时第 12 次更新从整个主 buffer 消失；60×20 和 40×12 的高 Tasks 都能挤掉 LATEST。原诊断文件和用户中间实现已备份，正式回归现在检查新交互语义。

## Pi 参考的版本纠正

用户实际命令 `/opt/homebrew/bin/pi` 来自 `@earendil-works/pi-coding-agent` **1.0.2**；其 `dist/core/settings-manager.js` 默认 **fullscreen**。本地参考仓库的默认值则是 **regular**，两者不能混用。

Pi fullscreen 的 `ChatViewport` 是固定高度的 `VStack`：上方 `ScrollView(document, follow=end)` 占剩余空间，下方 dock 包含状态、widgets、editor、footer。它把完整文档裁成可视区域，再由同一个 renderer 合成屏幕；并非两个输出进程或用背景色遮住正文。上滚暂停 follow，新输出继续增长文档，用户回到底部才重新跟随。

此次保留 React/Ink 8；使用其公开的 alternateScreen、Box overflow/contentOffsetY、measureElement API，不另写终端 renderer，不引入硬件滚动区域，也不让两个 renderer 同时控制 stdout。

## 实施后的交互契约

- 交互 TTY 使用 alternate screen。完整正文始终保留于应用文档，包括还没闭合的段落、代码和表格；不再在生成期间截掉前文来腾位置。
- 上方输出 viewport 与下方 dock 分配互不重叠的行。普通状态至少保留 3 行输出；审批在小窗口优先获得可操作的高度，并至少保留 1 行正文。
- Tasks 默认一行概要，Ctrl+T 展开；展开高度受预算约束，空间不足自动回概要，原展开选择仍保留。
- 滚轮在输出区滚动；Shift+PgUp/PgDn 或 Ctrl+B/F 翻页，Shift+Home 到开头，Shift+End 回最新。原普通 PgUp/PgDn 草稿导航/历史加载和 Alt+PgUp/PgDn Tasks 翻页保留。
- 上滚后保存消息身份与消息内行号。新 token、加载更早历史、窗口缩放与 Tasks 高度变化不强制跳到最新。
- 审批替换 dock 内编辑区域，Prompt 保持挂载，草稿不丢失。
- 命令面板同样优先获得 dock 空间。80×12 下连接表单跟随选中字段，长输入保留尾部和光标；模型等长列表可用 PgUp/PgDn 阅读。
- 静态历史的离屏消息只保留等高占位与阅读锚点，进入可视范围重新绘制。宽度、主题、内容和工具展开改变时失效重测，避免每个 token 都解析所有离屏正文。
- Ink 单独拥有终端生命周期。输出 adapter 只合并同步帧的 write，不再重写 Ink 的 erase 前缀或光标指令。
- 退出 alternate screen 后，完整当前会话正文追加回主屏一次；signal 路径等待输出排空再结束 host，避免退出时丢正文。

## 审查与额外修正

调用 `github-copilot/claude-opus-5.5`、medium，通过 calling-pi-agent 做只读设计复核。完整原始意见已在本次对话呈现。采纳：保留完整正文、消息级阅读锚点、离屏绘制限制、鼠标输入隔离、备用滚动键、退出回显。没有引入完整自制选择/搜索系统。

实现后再次调用同一模型复核最终 diff。它未发现已确认的必修 P1/P2；提出的测量时序、面板内备用滚动键和 context 更新成本是后续观察项，并非复现问题，不据此扩大本轮范围。Pi 做了代码阅读，没有独立执行测试。

同时修正 Pi 中间改动的两个回归：

- 独立解析 Markdown 小段会破坏跨行斜体、跨行链接和 reference link，后者可能丢掉 URL。恢复公共 Pi Markdown 的整体解析，增加相应回归。
- 启动颜色探测按 chunk 转 UTF-8 字符串会损坏分包中文。改为保留字节，返还非协议输入，覆盖中文/emoji 逐字节输入及半字符超时。

保留经检查的主题背景、编辑器导航、shimmer 改进。统一 ESLint projectService 的窄测试白名单，修复混合 lint 顺序导致的配置错误。

## 验证记录

- 核心新语义测试：真实 Ink + Readable stdin + xterm 共 10 项通过，覆盖长段落、上滚持续生成、500 条历史、加载旧历史、resize、文本封口成 fragment、离屏内容替换、工具展开、小窗口真实审批和草稿。
- 生产进程 PTY：`python3 scripts/run-tui-improve4-stream-pty.py`，80×24 dark、60×20 dark、80×12 light，各 90 个阶段通过。新 validator 按阶段把实际 ANSI 喂入 xterm，直接断言可见单元格，包含长无换行编号中文段落、滚轮后整屏保持、Tasks、resize、审批 Down+Enter、草稿原文提交、表格/列表以及退出正文。
- PTY 原始证据：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve4-stream-pty-4t6zqsgq`，包含 ANSI、阶段偏移、screens JSON、主屏退出正文和 cells-summary。
- 出口验证：4 项实际生产 renderTerminalUi/Ink/xterm 语义测试及 3 项 signal 排空顺序测试；鼠标 5 项、纯合帧 8 项通过。
- 面板验证：实际生产 renderTerminalUi/Ink/xterm 覆盖 80×24、80×12 的连接字段、协议选择、120 字符输入尾部与光标、搜索密钥遮罩、模型分页和子代理浏览器。修复复核中发现的小窗口表单裁切，相关 6 个文件 163 项测试及追加长输入回归通过。
- 性能现场对照：同一台机器 500 条历史下，Ink 单帧绘制由 24–29ms 降至 1–3ms。该数字是现场观测，不是所有终端的性能保证；正式测试不使用不稳定的耗时阈值。
- 子代理最终复核 culling、fragment 锚点、分页键路由及命令面板，没有新增未解决的 P1/P2。
- 最终 `pnpm run preflight` 退出码 0：format、lint、typecheck、完整测试与工作区 build 通过。515 个测试文件通过、6 个跳过；5,692 项测试通过、17 项跳过。lint 为 0 错误、109 条既有警告；构建保留 web chunk 大小提示。日志：`/tmp/ohbaby-improve4-preflight-verified.log`。

## 本地改动整理与边界

修改前将暂存区与工作区的 binary patch、状态及会话解析存到独立临时目录；被替换的 Markdown 分段实现、ANSI 改写和诊断脚本另存临时备份。

原始暂存区/工作区备份：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve4-continuation-mh2j4lvy`，包含 `staged.patch`、`unstaged.patch`、`status.txt` 和导出会话的解析结果。

`.pi/sandbox.json`、`.pi/tasks/**`、会话 HTML 和已删除的 `measure-stream.tmp.tsx` 不进入产品提交。运行记录保留本地，通过本仓库 `.git/info/exclude` 排除，不更改用户全局忽略规则。既有 improve-1～3/plan 文档单独归档，不能称作本轮新实现。

GUI 验收有明确限制：Computer Use 返回 `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.`，未绕过。真实 PTY 与 xterm 能验证输入、单元格、光标、模式恢复，不能证明所有终端的触控板手感、IME 或原生复制。启用鼠标上报后，原生拖选需要终端自身的选择修饰键（依终端设置）；未实现 Pi 的自定义选区和搜索。退出后完整文档在主屏可供原生选择、复制和搜索。

非 TTY 仍走顺序输出；旧 Static 路径仅保留给既有内部 regular/fallback 场景，不承诺它具备 fullscreen 的独立 dock 交互。

## 闪屏修复后的连续滚动补充

用户确认闪屏已经解决，继续反馈生成期间滚动不顺畅，要求主动阅读历史时保持位置、停在底部时自动跟随。本次以 `7479c782` 为基线，仅修正滚动输入与刷新，不调用 Pi，不改已验证的分区结构。

真实 Ink + xterm 复现了两处问题：同一输入块的 5 次上滚原本应移动 15 行，实际仅移动 3 行；连续两次 Shift+PgUp 也只生效一次。原因是所有事件从同一次 React render 的旧 `offset` 计算，批处理最终覆盖前面的移动。另一个问题是鼠标停在普通 prompt/Tasks 上时被命中区域判断排除，滚轮完全不生效。检查未发现 running 状态禁用滚动或每次 token 重置会话身份。

修复集中在 `FullscreenShell`：输入游标同步累计，React 按最终位置绘制；上滚进入历史阅读状态，新输出不抢位置；用户向下滚到底部或按 Shift+End 才恢复跟随。普通控制区上的滚轮也浏览正文，审批/命令面板仍保持区域隔离。缓存未变化的 viewport context，避免每个 token 都通知正在阅读的历史消息重新绘制。

新增 7 项输入突发回归，覆盖同块/同轮多块滚轮、连续键盘翻页与输出同时到达、方向切换、阅读期间持续生成、回底恢复跟随和控制区隔离。旧实现 6 红、1 绿，修复后全部通过。原有锚点、加载历史、缩放、500 条消息、审批、prompt 等回归保留。

验收：TUI 全部 68 个测试文件、667 项测试通过；类型检查和 CLI 构建通过。生产 PTY 的 80×24、60×20、80×12 各 93 阶段通过，共 279 阶段，额外比较批量 5 次滚轮与分次 5 次滚轮的最终屏幕完全一致，并验证向下滚回底部后继续跟随生成。证据目录：`/var/folders/md/0szgsv_x3bsdgk_fzj9qb6lh0000gn/T/tui-improve4-stream-pty-a8ubu075`。

子代理独立复现及最终 diff 审查完成，独立重跑原有 10 项 fullscreen 回归通过，没有已确认未解决的 P1/P2。GUI 触控板手感仍受上述电脑控制权限限制；本轮验证的是连续输入语义、真实进程与终端单元格结果。
