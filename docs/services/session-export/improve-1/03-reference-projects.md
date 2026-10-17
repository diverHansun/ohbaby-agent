# 3. 优秀项目借鉴

> 调研时间：2026-10-17。所有路径都相对于 `~/Projects/code-cli/`。本次按本地 HEAD 重新核对源码，完整证据、版本和限制见 [investigation](./investigation/README.md)。

## 3.1 借鉴来源

| 项目 | 关键路径 | 调研范围 |
|---|---|---|
| codex | `codex/codex-rs/tui/src/app/transcript_export.rs`、`tui/src/slash_command.rs:50` | TUI 的 `/export`（Markdown） |
| opencode | `opencode/packages/schema/src/session-transfer.ts`、`packages/core/src/session/transfer.ts`、`packages/app/src/home/sessions/view.tsx:783`、`packages/tui/src/routes/session/index.tsx:1220-1262` | JSON 导出和导入、网页会话菜单里的 Export… |
| pi | `pi/packages/coding-agent/src/core/export-html/`、`src/core/session-export.ts` | HTML 导出、JSONL 导出和导入 |
| kimi-code | `kimi-code/apps/kimi-code/src/tui/utils/export-markdown.ts`、`packages/agent-core-v2/src/app/sessionExport/` | Markdown 导出、调试 ZIP |
| deepseek-harness | `deepseek-harness/packages/session-query/session-log-export/` 及其设计笔记 `.agents/notes/archived/feature/2026-08-10-web-session-log-export.md` | 网页导出 ZIP（内含 JSONL），以及浏览器下载 |
| ZCode | `ZCode/packages/ui/src/TaskActionMenuContent.tsx`、`services/src/conversation-share/` | 菜单结构、云端分享 |

## 3.2 横向对比

| 项目 | 入口 | 格式 | 能导回来吗 | 保存位置 | 脱敏 |
|---|---|---|---|---|---|
| codex | TUI `/export` | Markdown | 不能 | 客户端 cwd，不覆盖已有文件 | 不做 |
| opencode | TUI、CLI、网页菜单 | JSON（TUI 还能导出 Markdown） | 能 | 网页走浏览器下载，TUI 存到临时目录 | 可选，整段替换成占位符 |
| pi | `/export [path]`，按扩展名选格式 | HTML（默认）或 JSONL | JSONL 能 | cwd | 本地 handler 没有额外秘密检测或提醒 |
| kimi-code | TUI `/export`（`/export-md` 别名）、`/export-debug-zip`；Web 导出 ZIP | Markdown、诊断 ZIP | 不能无损恢复 | Markdown 默认工作目录；Web 浏览器下载 | Markdown 会过滤内部消息来源，不是秘密检测 |
| deepseek-harness | 网页 `/export`、头部菜单 | ZIP（JSONL + 附件） | 不能 | 浏览器下载 | 不做 |
| ZCode | 云端分享 | 公开投影和附件，返回 URL | 可作为新会话上下文，不是无损恢复 | — | 白名单投影内部字段，无正文秘密检测，发布需确认 |

## 3.3 可借鉴点

| 项目 | 做法 | 为什么相关 | ohbaby 怎么取舍 |
|---|---|---|---|
| pi | 单文件 HTML：数据转成 base64 嵌进去，内联 marked，浏览器端渲染，思考和工具可以折叠 | 用户指定参考 pi 的 HTML | **采用**（见 architecture §四） |
| pi | marked 的 `tokenizer.html` 和 `tag` 返回 `undefined`，URL 走白名单，`escapeHtml` | 消息里的 HTML 不能执行 | **采用** |
| pi | 运行时用 readFileSync 读模板 | 打包时要额外拷贝资源，pi 自己出过错 | **改造**：改成构建期生成 TS 常量 |
| pi | `String.replace` 传字符串，导致 `$` 被吃掉 | 是 bug | **不采用**：改成传函数 |
| pi | 没有 CSP，用内联 onclick | 打开页面时可能请求远程资源 | **改造**：加 CSP，改用 addEventListener |
| pi | 用正则检查模板源码来测 XSS | 没能测出 `$` 的 bug | **改造**：在 jsdom 里真正执行页面脚本 |
| pi | JSONL 第一行是会话头，后面每行一条记录 | 用户倾向用 JSONL | **采用**行结构，字段由 ohbaby 自己定义 |
| opencode | `{ info, messages }`，消息带 reasoning、tool、tokens、cost | 参考消息内容和统计结构 | **部分采用**：保留 reasoning、tool、tokens；按用户要求不导出 cost 或估算费用 |
| opencode | 网页会话行菜单里放 "Export…"，文件名由标题转成 slug | 和我们的网页端需求一致 | **采用**菜单位置。文件名**不采用**标题，因为希望名称稳定且不依赖标题；OpenCode 清洗为空会回退 session ID，并非生成空文件名 |
| opencode | CLI/TUI 专用 export API 过滤未结束消息；Web/GUI 分页读取没有同样过滤 | 运行中的会话 | **不采用**：我们是为了保存记录，导出全部内容并标注状态 |
| codex | 写文件时不覆盖已有文件（`persist_noclobber`） | 防止误覆盖 | **采用**：`wx` 加上 `-1`、`-2` 后缀 |
| codex | 导出完整历史，而不是只导出屏幕上能看到的 | 和 compact 有关 | **采用**：ohbaby 读的是数据库，包含 compact 掉的 part |
| kimi-code | 文件名带秒级时间戳，但普通写入仍可能同秒覆盖 | 可读命名与防覆盖需要分别处理 | **采用**命名；防覆盖用独占写入 |
| kimi-code | 从当前模型上下文导出，compact 后旧助手和工具原文不完整，部分用户消息保留 | 反面例子 | **不采用** |
| deepseek-harness | 源码由浏览器下载，并拒绝 Web `/export` 的路径参数 | 说明保存位置属于客户端；原指定笔记没有那句关于主机路径的引文 | **采用**客户端保存的职责划分 |
| ZCode | 菜单里有 Pin、Rename、Archive，没有 Export | 菜单项不宜太多 | 印证了"一项 Export 加子菜单"的选择 |

## 3.4 明确不借鉴

- codex 和 kimi 的 Markdown 导出。用户选的是 HTML 加 JSONL。
- opencode 和 pi 的导入功能。这一版不做。
- deepseek 和 kimi 的调试 ZIP，以及把子代理打包进去。这一版不导出子代理的过程。
- pi 的分支树侧边栏、分享链接、主题注入、highlight.js。线性会话用不上，或者太大。
- opencode 的 sanitize（整段替换成占位符）。替换之后记录就没法看了，失去了留存的意义。

## 3.5 对 02 方案的影响

- HTML 的整体做法、XSS 防护：直接来自 pi。CSP、生成式资源、`$` 修复是针对 pi 问题做的改进。
- "内容交给调用方保存"：来自 deepseek-harness、OpenCode 和 Codex 客户端保存的实际源码行为，以及对 ohbaby 远程模式的分析。
- 网页端菜单的位置：来自 opencode。
- 不覆盖文件、文件名带时间戳：来自 codex 和 kimi。

## 3.6 内容与安全边界补充

- Pi HTML 导出全树并可包含 systemPrompt、工具定义、隐藏 custom_message；JSONL 只导当前分支。ohbaby 仅借鉴页面结构，两种格式统一使用自己的白名单数据。
- Pi 当前内嵌 marked 18.0.5，ohbaby 使用 15；配置要以实际渲染测试验证。Pi 模板的 `$$` 问题发生在脚本字符串 replacement 阶段，不是 base64 正文被直接替换。
- OpenCode 的 Markdown 会跳过部分 JSON 消息类型，Web 与 TUI 的过滤也不同；ohbaby 采用同一 Collector。
- ZCode 的公开分享删除内部字段、重建引用；不能把“无秘密检测”写成“原始对象不经处理”。
- Codex 在临时会话、旧后端降级时可能回退可见 transcript；完整读取不是跨所有版本的绝对保证。
