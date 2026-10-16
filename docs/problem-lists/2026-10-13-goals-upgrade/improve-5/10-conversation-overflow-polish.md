# 主会话与子会话长内容边界收尾

日期：2026-10-16。实施分支：`main`，基线：`9ff6c0cb`。

## 问题与改动

浏览器复现确认：主会话用户气泡宽约 479px，内容滚动宽度达到 3832px；子代理浮层会话区域宽约 628px，滚动宽度达到 3995px。长 URL、连续字符串和 Markdown 表格可溢出消息边界。

主、子会话都使用 `ConversationStream` / `MessageRow`。修复集中在 `apps/ohbaby-web/src/ui/conversation/messages.css`：

- 消息正文允许收缩；Markdown 与流式正文中的长字符串在边界换行。
- Markdown 代码块、表格限制在正文宽度内，保留格式并在自身内部横向滚动。
- Markdown 图片限制为正文宽度，保持比例。

`ReasoningDetails` 已将 summary 与可横向滚动的 pre 分开，子会话也复用它，因此没有重复增加子会话逻辑。普通推理段落继续换行，长链接可在 pre 内滚动，标题和箭头不参与滚动。

## 验证

- Web 生产构建通过；仍有 Vite 大于 500kB 的 bundle 提示。
- MessageRow、ConversationStream、SubagentView、subagent-layout、styles 共 5 个测试文件、42 项测试通过。
- 使用原生浏览器控制进行手动 E2E：真实 HTTP 服务、SQLite 与生产 Web 构建，隔离的临时工作区；预置主/子会话长内容，模型使用确定性测试 provider，没有请求真实模型 API。
- 桌面 1280×850：打开子代理浮层、展开、收起、关闭；长 URL 和行内代码保持在气泡内，代码块和宽表格各自滚动。浮层 stream 的 clientWidth / scrollWidth 均为 788px，气泡均为 562px。
- 子会话推理滚动至右端：scrollLeft = 2676，等于 scrollWidth - clientWidth；继续滚动不再增加。标题 x 始终为 290.5px，外层 stream.scrollLeft 为 0，标题仍可折叠。
- 窄屏 390×844：文档宽度为 390px；主会话与展开子会话 stream 的 clientWidth / scrollWidth 均为 324px，气泡均为 254px；子代理浮层 stream 均为 294px。
- 窄屏主会话推理右端为 3152px，等于最大滚动距离，标题 x 保持 80px，外层无横向滚动。
- 在浏览器输入框发送长 URL 与行内代码，收到测试 provider 回复；刷新后提示词和回复保留，气泡没有溢出。控制台未捕获 warning / error。
- 视觉检查覆盖桌面父代理提示词、子代理回复、窄屏提示词及推理正文。

## Pi 调用结果

先调用用户指定的 `opencode/gemini-4-argon-contributor`，返回模型不可用。用户同意改为 `opencode-go/gemini-4-argon-contributor` 后，medium 调用仍失败：`Provider opencode-go has no API implementation for "google-generative-ai"`。

Pi 没有产出审查或修改。本次代码分析、修复和浏览器验收由主代理完成；不将失败调用计为独立审查通过。
