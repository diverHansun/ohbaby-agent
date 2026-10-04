# improve-4：TUI 输出降噪与流式阅读收尾

开启日期：2026-10-04。根据用户在 improve-3 验收后的截图反馈继续实施；本地分支 `improve-4`，基线 `7d802c4f`。不 merge、不 push，等待用户审核。

本轮沿用 [improve-3 验收记录](../improve-3/05-implementation-and-acceptance.md) 的 React/Ink、单一终端输出层、两行底栏、Ctrl+O 与真实历史修正规则。用户已授权直接实施，本轮不重新编写一套前端架构规划。

范围：权限选项重复与过多提示、subagent_status 原始 JSON、工具预览降噪，以及长回复生成中前文没有进入终端回滚区。记录见 [实施与验收](05-implementation-acceptance.md)。

用户再次实测反馈后的逐 token 闪屏、PgUp/PgDn 光标与等待动画改动，见 [补充排查与验收](06-stream-render-cursor-animation.md)。

再次反馈后的根因复现、独立输出 viewport/dock、应用内滚动、退出回显和改动整理见 [独立输出区收尾](07-independent-transcript-viewport.md)。06 文档中的 Markdown 分段和 ANSI 改写是已被替换的中间方案。

闪屏和连续输入修复后，进一步的构建去重、滚动排版复用及等待动画节奏调整见 [性能与节奏收尾](08-build-scroll-animation-polish.md)。

实际 GUI 滚动体验与进程自动化分开验收；电脑控制无法访问系统 Terminal，不能以 PTY 结果替代鼠标滚轮、触控板和中文 IME 验证。
