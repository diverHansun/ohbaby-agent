# TUI 网页链接与历史导航收尾

日期：2026-10-16。最初按用户要求保留 main 工作区改动；随后用户明确要求使用 `opencode/gemini-4-argon high` 再审查，并在验证后 commit / push 本次 TUI 改动。

## 问题与实现

- `render/markdown.ts` 原来强制关闭 Pi 的 hyperlinks 能力；即使开启，`render/wrap.ts` 也会过滤全部 OSC 序列。因此链接只剩颜色、下划线和可见文字。
- 现在恢复 Pi 的终端能力检测。支持 OSC 8 的终端得到网页链接；不支持时仍显示可复制的 URL。参考本地 Claude Code 的 OSC 8 / URL 降级方式，以及 Codex 对网页链接目标的校验，不另建鼠标点击处理器。
- 原始 Markdown 仍先移除 OSC、光标和剪贴板指令。仅在渲染结果的换行阶段保留经过校验的 HTTP / HTTPS 链接，其他输入继续使用原来的过滤规则。沿用 Pi 的逐行关闭 / 重开链接逻辑，避免换行后的链接范围蔓延到边框和输入框。
- `layout/fullscreen-shell.tsx` 新增 `Ctrl+Y` 回到最新输出并恢复跟随。原 `Shift+End` 保留兼容。宽窗口显示 `History · Ctrl+B up · Ctrl+F down · Ctrl+Y latest`；窄窗口缩短方向提示，更窄时优先保留回到最新的入口。`Ctrl+B/F` 的 B/F 表示 backward / forward，实际行为是向上 / 向下翻页。
- 同批保留 TUI 链接颜色调整：独立浅色 `#53677D` / 深色 `#9AAFC1`，附带 URL 使用 `text.dim`；低色彩模式链接与 strong 文字按深浅背景使用白 / 黑，保留下划线识别。

## 验证

- 先补回归测试，原实现出现 6 项失败：链接信息缺失及新导航提示缺失；修复后相关 5 个测试文件共 71 项通过。
- 覆盖 Markdown 命名链接、裸网址、表格、长内容换行、不支持超链接时的 URL 降级、原始 OSC 注入和非网页目标过滤。
- FullscreenShell 合约测试通过实际 Ink 输出及 xterm OSC 解析器验证链接目标、关闭序列和 40 列缩放；真实 Prompt 验证 `Ctrl+B/F/Y` 不改变草稿。另通过子会话导航集成测试。
- `tsc -b`、改动文件 ESLint / Prettier 和 `git diff --check` 通过。
- 用真实 AppShell / MessageRow / Ink 渲染并由 xterm 解析，检查了浅色 100 列、深色 40 列的历史提示和链接样式；两种尺寸均验证 `Ctrl+Y` 回到最新。浏览器仅用于展示这些终端输出快照。
- 原生 Ghostty 的 computer-use 访问被工具安全限制拒绝，未进行真实 Command+点击验收，不将协议与快照验证等同于操作系统默认浏览器跳转验收。Ghostty 官方文档说明支持 OSC 8，macOS 链接使用 Command 修饰键并交给系统默认应用：<https://ghostty.org/docs/vt/external>、<https://ghostty.org/docs/config/reference#link-url>。

视觉记录：`/Users/hansun025/.codex/visualizations/2026/10/15/01a13fe5-1b1e-7693-8b5c-6669a3843fdd/conversation-overflow/tui-hyperlinks-history.jpg`。

## 主 / 子会话复查

- 追踪子会话最终输出后发现遗漏：`SubagentBrowser` 会对共享 `renderMessageParts` 的结果再次使用默认 `wrapAnsi`，移除此前生成的 OSC 8。新增 40 / 80 列测试先复现失败，再把可信消息渲染结果与原始工具输出、元数据、stored result 分别换行；只在前者保留经过校验的网页链接。
- 新测试按可见终端列检查链接目标，覆盖长标签、长目标 URL、正文及表格。链接字符可点击，表格分隔线、后续普通文字和行末无点击目标。子会话工具结果和 stored result 中伪造的 OSC 8 仍被移除。
- 显式换行的链接标签还暴露了逐行关闭缺口：Pi 渲染出的某些行以未关闭的 OSC 8 结束，交给 Ink 后会把下一行的引用块前缀也纳入链接。`wrapAnsi` 现在为每个仍开放的链接补关闭，原有已关闭行不重复添加。新增显式换行回归先红后绿，并在完整 Ink 的长表格 / 引用块 / 40 列缩放输出上逐列确认边界。
- Pi 另复现了 Ink 二次换行的终止符兼容问题：将 80 列格式化结果交给 12 列 Ink 容器时，ST 终止的链接在内部换行后可能蔓延到后续普通文字。主代理用无色 / truecolor 两种测试确认失败，将应用输出规范化为 BEL 终止的 OSC 8 后通过。输入仍兼容 ST / BEL，原始控制指令仍被过滤。中文 / emoji 的范围测试按 grapheme 的终端列宽验证，避免字符串下标与屏幕列混淆。
- 真实 `OhbabyTerminalApp` 的 60×20 子会话分页集成测试检查每页链接范围，包括分页后从链接中间开始显示的页面。子会话打开时 `Ctrl+Y` 不触发主会话；主会话仍由 FullscreenShell 合约测试验证跳到最新和草稿保留。
- 极窄到无法容纳表格的宽度（如 8 列）沿用 Pi 的原始 Markdown 降级，保留地址文字；不声称此降级形式仍有 OSC 点击目标。
- 扩展回归共 15 个测试文件、140 项通过；类型检查、CLI 构建、源码 ESLint 通过。仓库标准 ESLint 不包含这份 `tests/integration` 文件，单独指定该文件会因其不在 project service 范围内失败；该文件通过 Vitest 执行与 Prettier 检查，未为此扩大 lint 配置。
- Pi 按用户指定使用 `opencode/gemini-4-argon`、high，只读审查会话 `22eb5431-0790-4aca-a4ef-fe97a32a1c9a`。最终确认当前版本无阻塞提交的缺陷，独立执行 7 个文件共 68 项测试通过；同时保留原生 Ghostty Command+Click 未实测的限制。主代理核实并修复上述问题后负责提交与推送，Pi 未执行 Git 写入操作。
