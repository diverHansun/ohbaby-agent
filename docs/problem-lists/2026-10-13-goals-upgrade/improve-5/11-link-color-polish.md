# Web / TUI 链接视觉收尾

日期：2026-10-16。用户要求改善浅蓝气泡中刺眼的默认蓝色链接，并分析 TUI。用户随后要求撤回最近一次提交且当轮不 commit / push；`454fc1bc` 已软撤回，焦点修复及测试保留为未提交改动，当时 HEAD 为 `4fb4d858`。2026-10-17 用户重新授权：检查剩余 Web 改动，测试通过后提交并推送；见下方最终验收。

## 现状与参考

Web 的 `.ohb-markdown a` 没有覆盖浏览器默认样式，实测颜色为 `rgb(0, 0, 238)`。主会话与子会话共享 MarkdownBlock，样式应在共享消息 CSS 中处理。无需修改 URL、Markdown 解析或会话结构。

以下是本地参考项目的实际代码，而非对产品外观的猜测：

| 项目与文件 | 做法及取舍 |
| --- | --- |
| `claude-code/src/utils/hyperlink.ts` | 支持 OSC 8 时使用 `chalk.blue` 并保留终端换行兼容；无支持时直接显示 URL。其 ANSI 蓝色服务于终端兼容，不照搬到浅蓝 Web 气泡。 |
| `codex/codex-rs/tui/src/markdown_render.rs`、`style.rs` | 链接使用 accent + underline；按终端背景选择强调色，并经过对比度适配。借鉴背景适配与下划线识别，不复制品牌蓝。 |
| `kimi-code/apps/kimi-code/src/tui/theme/pi-tui-theme.ts`、`colors.ts` | 链接标签使用 primary，附带地址使用 textMuted；深浅主题分别定义颜色。借鉴标签与地址分层。本地未找到其 Web 原始样式源码，只有构建产物，不据此声称复刻 Web 方案。 |
| `pi/packages/coding-agent/src/modes/interactive/theme/theme.ts`、`light.json`、`dark.json`；`packages/tui/src/components/markdown.ts` | mdLink / mdLinkUrl 分层，链接加下划线；无 OSC 8 时，标签不同于目标地址才附上地址。ohbaby 已使用该渲染器，继续保留完整可复制地址。 |

## 实施边界

本轮限于链接颜色、可识别性与既有长内容边界，不重做布局或增加卡片、图标、点击处理器。

TUI 的用户 prompt 走纯文本 `wrapAnsi`，assistant 正文走 `mdToAnsi`；reasoning 也没有 Web 的可点击链接。因此不把 Web 锚点逻辑移植到终端。

- Web 仅在 `.ohb-markdown` 内设定链接色 `#53677d`，visited 同色；下划线为 1px、偏移 2px、45% 不透明度。hover / focus-visible 使用 `#3b4d61`，键盘焦点另有 2px 轮廓。代码形式链接继承颜色。链接色在白底 / 浅灰页面 / 浅蓝气泡上的对比分别约为 5.83 / 5.58 / 5.24。
- TUI 增加独立 link 调色值：浅色 `#53677D`、深色 `#9AAFC1`，不改变工具和品牌使用的 skyBlue。
- 保留渲染器原有下划线；附带 URL 改用 `text.dim`，避免深色模式地址过暗。
- 低色彩模式链接使用浅色黑字 / 深色白字；浅色模式 strong 同样改为黑字，修复代码形式链接发白的问题。无色模式继续完整显示标签和 URL。
- 对比度测量：浅色 link 对默认 surface / userBlockBg 为 4.91 / 4.68；深色 link 为 7.82 / 6.77。深色附带 URL 从 3.18 / 2.75 提升为 5.83 / 5.05。仅针对默认主题背景，终端自定义 ANSI 调色板和背景仍受用户设置影响。

## 验证记录

- 最终 Web 与 TUI 渲染、换行、主题回归共 10 个测试文件、81 项通过。调试期间额外验证了深浅主题在 0 / 1 / 2 / 3 色彩等级及 24 / 80 列下的完整 URL、宽度与下划线；纯样式小修不保留新增的重复静态渲染断言。
- TUI MessageRow / MessageList 及子代理导航集成 3 个文件，29 项通过，包含 60×20 会话导航。
- 使用真实 MessageRow + Ink `renderToString` 生成 ANSI，由 xterm-headless 解析单元格颜色后在浏览器截图检查深色、浅色、16 色及无色输出；这是实际渲染输出的视觉检查，不等同于真实终端软件的鼠标、选择复制或键盘交互验收。
- 主代理使用独立本地 HTTP / SQLite fixture、生产 Web 构建进行 1280px 桌面浏览器验收；主会话、子代理浮层和展开会话均使用新链接色，淡蓝气泡与白色正文中的长链接保持在边界内。实际 Tab 聚焦代码链接时颜色为 `rgb(59,77,97)`，轮廓为 2px，代码文本同步继承。保存了优化前后截图与 TUI 输出截图。
- Web 构建及全仓 `tsc -b` 通过；仍有原有的大于 500kB bundle 提示。本轮未调用真实模型 API 验证界面。

## Pi 分工

按用户指定使用 `opencode-go/gemini-4-argon-contributor`、high，负责 Web 样式。此次调用可正常使用模型，但 Pi 的沙箱不能读取兄弟参考仓库。主代理直接读取相关源码后提供事实与路径，避免修改沙箱权限。主代理负责 TUI 与最终浏览器验收；该轮未提交或推送。

## 2026-10-17 Web 最终复核

TUI 改动已在 `965a07e2` 提交并推送。本次复核剩余 Web 链接样式、子会话焦点修复和对应测试；长内容边界沿用已提交的共享样式。

- 全量 Web 测试 `pnpm exec vitest run apps/ohbaby-web/src`：44 个文件、591 项通过，包含单元、集成与契约测试。Web 生产构建通过，仍有原有的 500kB bundle 提示。
- 原生浏览器控制验收独立 HTTP / SQLite fixture 与最新生产构建，未请求真实模型 API；浏览器未捕获 warning / error。
- 1280px 桌面：主会话气泡 clientWidth / scrollWidth 均为 572px；子会话浮层气泡均为 562px、stream 均为 788px。展开子会话 stream 均为 1207px。长 URL 换行后仍在正文边界内。
- 390×844 窄屏：实际 innerWidth 与文档宽度均为 390px；主会话、展开子会话 stream 均为 324px，气泡均为 254px；子会话浮层 stream 均为 294px，气泡均为 226px。可见链接行片段的 DOM 命中目标仍为对应锚点。
- 主/子会话共享 `#53677d` 链接色，行内代码链接继承颜色；键盘 focus-visible 为 `#3b4d61` 与 2px 轮廓。已保存桌面主/子会话及窄屏截图并人工检查。
- 主/子会话推理右端 scrollLeft 分别为 2676 / 2688px，等于最大滚动距离；外层 stream.scrollLeft 为 0，Thought 标题不随正文横向移动。折叠后 Tab 跳过正文，展开后可聚焦正文；首尾 Tab / Shift+Tab 循环正常。
- 验收额外发现：焦点在展开子会话面包屑时，Escape 收起会移除聚焦按钮，导致下一次 Escape 失效。先扩充回归断言并确认原实现失败，再让视图展开状态变化时聚焦子会话标题。复验连续两次 Escape 正常收起、关闭，并恢复主会话委派入口焦点。详见 `10-conversation-overflow-polish.md`。
