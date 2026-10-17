# session-export 模块 architecture.md

前置文档：[goals-duty.md](./goals-duty.md)。下文每个组件都标了它服务的目标（G）和职责（D）。

---

## 一、Architecture Overview（总体架构）

模块对外只有一个入口。内部分三步：**收集 → 渲染 → 打包结果**。

```
                 exportSession(sessionId, format)
                              │
                ┌─────────────▼──────────────┐
                │ Collector（收集）           │  D1 D2 D3 D7
                │ 读 session + 主上下文消息    │
                │ 过滤 / 标注 / 汇总统计       │
                └─────────────┬──────────────┘
                              │ ExportDocument
              ┌───────────────┴────────────────┐
     ┌────────▼────────┐              ┌────────▼────────┐
     │ JSONL Renderer  │  D4          │ HTML Renderer   │  D5
     │ 一行一条记录     │              │ 模板 + 嵌入数据   │
     └────────┬────────┘              └────────┬────────┘
              └───────────────┬────────────────┘
                ┌─────────────▼──────────────┐
                │ 入口：生成文件名，组装        │  D6
                │ ExportResult                │
                └────────────────────────────┘
```

| 组件 | 负责什么 | 依赖 |
|---|---|---|
| **入口（index）** | 校验参数，按格式选渲染器，生成建议文件名，返回 ExportResult | Collector、两个 Renderer |
| **Collector** | 读会话和消息，转成 ExportDocument。过滤规则见 [data-model.md §二](./data-model.md) | 注入的 `SessionManager.get`、`MessageManager.listBySession` |
| **JSONL Renderer** | ExportDocument → JSONL 字符串 | 无 |
| **HTML Renderer** | ExportDocument → 单文件 HTML 字符串 | 生成好的模板资源 |
| **HTML Viewer（模板）** | 在浏览器里运行：解码嵌入的数据，渲染页面，处理折叠 | 内联的 marked |

依赖方向是单向的：入口 → Collector / Renderer → core 的类型。模块不依赖 adapter、server、TUI，也不依赖 `adapters/ui-state` 的 UI 投影。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 用了什么："中间数据 + 多个渲染器"

Collector 产出一份 ExportDocument，两个渲染器各自消费它（G3）。

- 过滤和标注规则只写一遍，HTML 和 JSONL 的内容范围自然一致。
- 渲染器是纯函数，输入一个对象、输出一个字符串，测试最简单。

### 2.2 刻意没用的

- **没有用 Strategy 注册表或插件机制。** 现在只有两种格式，入口里用一个 `switch` 就够了。等真有第三种格式再考虑（YAGNI）。
- **没有复用 UI 投影（`adapters/ui-state/persistent-store.ts` 的 `messageToUiMessage`）。** UI 投影会去掉 compact 掉的 part，摘要只显示一行，还会把 todo 工具藏起来，这和 G1 冲突。而且它属于 adapter 层，导出模块依赖它会让依赖方向反过来。代价是 displayText、sourceOrder、runtimeInput 这几条规则要在 Collector 里再写一份，大约十几行，见 data-model §2。
- **没有做流式输出。** 会话内容一次性读进内存，拼成一个字符串。这是为了保持简单而接受的代价。会话可能很大（MCP 输出、图片、长历史），而且经过 RPC 时还会整份复制一次，所以大会话的耗时和内存要在验收时实测。实测结果不能接受时，再考虑流式输出。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
packages/ohbaby-agent/src/services/session-export/
├── index.ts                 对外入口：exportSession()，以及导出类型和错误码（稳定接口）
├── types.ts                 ExportDocument / ExportMessage / ExportPart / ExportResult
├── errors.ts                稳定的业务错误码
├── collect.ts               Collector
├── jsonl.ts                 JSONL Renderer
└── html/
    ├── render.ts            HTML Renderer：把数据填进模板
    ├── template.html        页面骨架（源文件）
    ├── template.css         样式（源文件）
    ├── template.js          浏览器端渲染脚本（源文件）
    └── assets.generated.ts  由脚本生成，不手改

packages/ohbaby-agent/scripts/generate-session-export-assets.mjs
```

- **稳定接口**只有 `index.ts` 导出的内容，其余文件都是内部实现。
- **模板资源的处理方式照搬 `system-prompt` 的做法**：`template.*` 和 marked 的 UMD 文件由 `generate-session-export-assets.mjs` 生成为 TS 字符串常量（`assets.generated.ts`）。构建脚本里加上 `--check`，确认生成结果没有过期。这样做的好处：
  - 运行时不需要读文件，tsup 打包、npm 发布都不用额外拷贝资源。pi 用的是"运行时 readFileSync，打包时拷贝资源"，它自己在打包上就出过错。
  - 模板仍然是正常的 `.html`、`.css`、`.js` 文件，编辑器能高亮，能 lint。
- **marked 的来源**：给 ohbaby-agent 加一个 devDependency `marked`，版本和 web 用的保持一致（`^15`）。生成脚本从 `marked/lib/marked.umd.js` 读出代码，写进 `assets.generated.ts`。运行时不依赖 marked 这个包。

---

## 四、HTML 页面结构与安全约束

参考 pi 的 `export-html`，只保留线性会话需要的部分。Pi HTML 包含全树，JSONL 只含当前分支；ohbaby 则明确要求两种格式使用同一份 ExportDocument。

### 4.1 页面组成

1. `<head>`：CSP meta、内联 CSS。
2. `<script id="session-data" type="application/json">`：ExportDocument 的 JSON 先做 UTF-8 编码，再转成 base64 放在这里。base64 里不会出现 `</script>` 或 `<!--`，所以不需要额外转义。这是 pi 的做法。
3. 内联的 marked UMD 和 `template.js`。浏览器端用 `atob` 加 `TextDecoder('utf-8')` 解码数据，然后渲染。

### 4.2 页面功能

**保留的：**
- 页面顶部保留标题与紧凑统计；编号、路径、时间、模型等完整元数据放入默认关闭的 `Session details`。
- 正文按 Markdown 渲染。
- 思考过程可以折叠，默认折叠。
- 工具调用可以展开。输出超过 20 行时先显示预览，提示"还有 N 行"。
- 工具输出里的 MCP 图片显示成图片，规则见 §4.3。
- compact 的标注和摘要块。
- 错误和中断的提示。
- 打印时展开全部详情，结束后恢复原状态；隐藏“还有 N 行”的操作提示，让长代码和输出自然跨页。
- 跟随系统的浅色和深色主题（`prefers-color-scheme`）。

**阅读版式（2026-10-17 Opus 视觉重做）：**单栏阅读页，正文约 46rem 行宽，暖白纸色背景（深色为暖黑），只用细线分段，不用卡片或边框盒。标题、统计数字、压缩摘要标题和思考正文用衬线体（系统内置 Iowan/Palatino/宋体回退，不加载远程字体），正文和界面文字用系统无衬线体，代码用系统等宽体。角色、统计标签和状态用小号大写字距。普通完成状态不再显示；运行中用冷色实心点，错误、中止、中断、长度截断用警示色实心点，消息级错误单列一行并带左侧警示线。时间按读者本地格式显示，原始 ISO 保留在 `datetime` 和悬停提示里；同一天的后续消息只显示时刻，完成耗时紧随其后。工具折叠行显示工具名和输入摘要（如命令或路径，单行省略），完整输入、输出、错误和 Call ID 在展开后保留。系统消息、子代理结果和压缩摘要缩进并带细左线，与对话正文区分。Markdown 容器采用 `white-space: normal`，用 marked `breaks: true` 保留正文软换行；行内代码和代码块用 `pre-wrap` 保留空格。折叠标题和链接有键盘焦点框；窄屏（≤560px）统计改两列、隐藏工具输入摘要、收紧缩进。数据无法解码时显示可读提示，而不是空白页。打印强制浅色、去掉折叠箭头，长代码和输出允许跨页连续排版。

**不做的：**
- 分支树和侧边栏、搜索、深链接、分享。线性会话用不上这些。
- highlight.js 代码高亮。它有 120KB，代码块用等宽字体显示就够了。
- 跟随 TUI 当前主题配色。
- 页面里的"下载 JSONL"按钮。需要 JSONL 时直接导出 JSONL 就行。

### 4.3 安全约束（G5）

| 风险 | 防护 |
|---|---|
| 消息里的 `<script>`、`<img onerror>` 等原始 HTML | marked 的 `tokenizer.html` 和 `tag` 都返回 `undefined`，HTML 一律当纯文本转义。参考 pi 的配置；pi 当前内嵌 marked 18，ohbaby 使用 15，因此必须执行最终 HTML 的安全测试 |
| `javascript:` 链接 | 链接和图片用两套规则。**链接**：先去掉控制字符，只允许 `https?`、`mailto` 和相对路径，被拒绝的链接只显示文字。**Markdown 正文里的图片**：一律不渲染成 `<img>`，只显示 alt 文字 |
| 插进页面的其他字段，比如工具名、模型名、数字 | 统一经过 `escapeHtml`。思考过程和工具输入输出按纯文本显示，不走 Markdown |
| 工具输出里的 MCP 图片 | 工具输出是纯文本，所以在转义之前，先单独提取 `![…](data:image/(png\|jpeg\|gif\|webp);base64,<只含 base64 字符>)` 这种片段，渲染成 `<img>`，剩下的文字照常转义。**SVG（`image/svg+xml`）和其他 MIME 类型一律不渲染**，因为 SVG 可以夹带脚本 |
| 打开页面时请求远程资源，等于给追踪服务器报信（pi 没防） | CSP 写成 `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`。效果是**页面不会自动加载任何外部资源**，图片只能是内嵌的 data URI。但用户点击允许的链接时仍然会跳转，这是正常行为。另外要注意：`'unsafe-inline'` 也会放行被注入的内联脚本，所以 CSP **不能**当作防脚本注入的第二道防线，防注入只靠前面几行。这一版不做脚本 hash |
| 内联事件属性 | 模板里不写 `onclick=` 这类属性，统一用 `addEventListener` |
| 模板拼接时 `$` 被当成替换语法（pi 的 bug：花费金额丢了 `$`） | `render.ts` 调用 `String.replace` 时传函数，不传字符串 |

---

## 五、Architectural Constraints & Trade-offs（约束与权衡）

| 选择 | 放弃的方案 | 代价 |
|---|---|---|
| HTML 在浏览器端渲染（pi 的做法） | 在后端渲染成静态 HTML、不带 JS | 每个 HTML 文件都会带一份 marked 和模板脚本，实际体积以构建产物为准。换来的是折叠交互，并且和 pi 的成熟实现保持一致 |
| 不用 DOMPurify，靠"禁用原始 HTML + 过滤 URL + 转义" | 像 web 一样用 DOMPurify | 安全性完全依赖 marked 的配置和转义是否正确，CSP 帮不上忙，必须用 [test.md](./test.md) 里的 XSS 用例守住 |
| 模块不写文件 | 模块直接写到 Downloads | 调用方要自己保存。好处是 TUI 和网页端共用同一个接口，远程模式下文件也写在用户自己的机器上 |
| 不复用 UI 投影 | 复用 `messageToUiMessage` | 少量规则写了两份（displayText、sourceOrder），UI 改规则时要记得同步 |
| 不做代码高亮 | 内联 highlight.js | 代码块没有颜色 |
