# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。

## 2.1 方案总览

把通用的 Markdown 样式收进一个文件 `shared/markdown.css`，规则都挂在 `.ohb-markdown` 上。各场景只决定基准字号和外层留白，标题、代码、表格的字号按基准算出来。中文加粗在 `MarkdownBlock.tsx` 里给 `marked` 加一个分词兜底。

```
shared/markdown.css          ← 标题、段落、列表、引用、代码、分隔线
        ▲
        │ 基准字号由外层决定
┌───────┼──────────────┬───────────────┐
聊天 14px   压缩摘要 13px   文件预览 14px    命令弹窗（继承）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| A1 样式放哪 | 新建 `shared/markdown.css`，在 `styles.css` 里紧跟 `shared/shared.css` 导入 | 样式和 `MarkdownBlock` 放在一起；排在 `messages.css` 前面，场景样式还能覆盖它 | 继续放 `messages.css`：文件预览要依赖聊天的样式文件 | 要搬一批规则 |
| A2 字号怎么算 | 标题用基准加差值：`calc(1em + 6px)`、`+3px`、`+1px`、`1em`；代码块和表格用 `calc(1em - 1px)`；行内代码用 `0.93em` | 14px 基准下正好是确认的 20/17/15/14/13；压缩摘要 13px 时整体跟着缩小 | 写死 px：压缩摘要里标题过大。纯 em 倍数：算出小数像素 | 读 CSS 时要算一下 |
| A3 正文字号 | `.ohb-message-body` 改成 14px，编辑框同步 | 回到设计文档，和文件预览一致 | 保持 15px：要改设计文档，和其他场景不一致 | 聊天文字比现在小 1px |
| A4 结尾边距 | **保留**助手消息最后一个元素的 12px 下边距，只把第一个元素的上边距清零；用户气泡里最后一个元素的下边距清零 | 这 12px 正是文字和工具行、操作按钮之间的间距（见 01 §1.5） | 照 opencode 全部清零：还要在消息层补一套间距规则，改动更大 | 文件预览底部多 12px，它本来就有 32px 留白，看不出来 |
| A5 连续标题 | 标题紧跟标题时，上间距收成 8px | LLM 常输出"# 标题"紧跟"## 小节"，24px 显得松 | 不处理：连续标题之间空得太开 | 多一条规则 |
| A6 中文加粗 | 给 `marked` 加 `emStrong` 分词兜底，标准规则匹配失败才走，判断规则取自 dsh | 不加依赖，不影响已经能解析的内容 | 引入 `remark-cjk-friendly`：它服务 remark 体系，和 `marked` 对不上 | 自己维护约 20 行代码 |
| A7 兜底范围 | 只处理成对的 `**`，且内容或紧邻的一侧必须有中日韩文字；内容里不能有 `*` 和换行 | 宁可漏修，不能误伤 `2 ** 3`、`src/**/*.ts` 这类文本 | 完整重写分隔符算法：工作量和风险都不值得 | `***粗斜体。***后面`、内容带星号的情况仍按标准规则处理 |

## 2.3 排版数值

基准字号指外层继承来的字号，聊天和文件预览都是 14px。

| 元素 | 字号 | 字重 | 行高 | 上 / 下间距 | 其他 |
|---|---|---|---|---|---|
| 正文 | 基准（14px） | 400 | 1.7 | 0 / 12px | |
| H1 | 基准 + 6px（20px） | 600 | 1.35 | 24 / 8px | 字距 -0.01em |
| H2 | 基准 + 3px（17px） | 600 | 1.35 | 24 / 8px | 字距 -0.01em |
| H3 | 基准 + 1px（15px） | 600 | 1.35 | 20 / 8px | 字距 -0.01em |
| H4 到 H6 | 基准（14px） | 600 | 1.35 | 20 / 8px | |
| 加粗 | 继承 | 600 | | | |
| 行内代码 | 0.93em（约 13px） | | | | 背景和圆角不变 |
| 代码块 | 基准 - 1px（13px） | | 1.6 | 0 / 12px | 面板样式不变 |
| 表格 | 基准 - 1px（13px） | | | 0 / 12px | 先原样搬文件预览的样式（含 `text-align: left`），表格议题再改对齐和布局 |
| 列表 | 继承 | | | 0 / 12px | 缩进 22px，相邻项间距 4px，嵌套列表上间距 4px |
| 引用 | 继承 | | | 0 / 12px | 左边 2px `--border-strong`，文字 `--text-muted`，左内边距 12px |
| 分隔线 | | | | 20 / 20px | 1px `--border` |

## 2.4 分阶段实施

### Stage 1：共用样式

- 目标：所有场景的 Markdown 字号和间距一致。
- 改动：
  - 新建 `shared/markdown.css`，按 2.3 写规则。从 `conversation/messages.css` 搬入 `.ohb-markdown` 的链接、代码、溢出、图片规则，以及 `.ohb-code-block`、`.ohb-code-copy` 相关规则。再加一条 `.ohb-code-block [hidden] { display: none; }`，Mermaid 和公式隐藏 `<pre>` 时都靠它。
  - `styles.css` 导入新文件。
  - `conversation/messages.css`：`.ohb-message-body` 和编辑框改成 14px；保留 `.ohb-message-body p`、压缩摘要规则和用户气泡里的代码块背景。下面三处只能搬一部分：
    - 触屏媒体查询：只搬 `.ohb-code-copy` 和 `.ohb-code-block pre`，`.ohb-message-actions` 留下。
    - `overflow-wrap`：`.ohb-markdown` 搬走，这里留 `.ohb-streaming-text { overflow-wrap: anywhere; }`，由流式议题 Stage 3 删除。
    - 用户气泡结尾：保留 `.ohb-message-user-bubble p:last-child`（引用里的最后一段靠它），再加 `.ohb-message-user-bubble .ohb-markdown > :last-child { margin-bottom: 0; }`。
  - `commands/notices.css`：`.ohb-command-notice pre` 和 `.ohb-command-notice.ohb-command-error pre` 都改成 `> pre`，不再盖住 Markdown 代码块。
  - `side-panel/files/files-page.css`：`.ohb-file-markdown` 只留颜色、基准字号、行高和内边距，其余规则删除。
- 完成定义：04 的 S-1 到 S-7 通过。

### Stage 2：中文加粗

- 目标：常见的中文加粗写法都能正确显示，其他文本不受影响。
- 改动：`shared/MarkdownBlock.tsx` 的 `Marked` 实例加 `tokenizer.emStrong`；`shared/MarkdownBlock.unit.test.tsx` 补用例。
- 下面的原型已在 `marked` 15.0.12 上跑过 04 的全部 29 个用例。`lastChar` 和 `firstChar` 只取字符串两端，长行上不会变慢：

```ts
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /^\s?$/u;
const lastChar = (s: string) => Array.from(s.slice(-2)).at(-1) ?? "";
const firstChar = (s: string) => Array.from(s.slice(0, 2))[0] ?? "";
const canOpen = (p: string, n: string) =>
  !SPACE.test(n) && (!PUNCT.test(n) || SPACE.test(p) || PUNCT.test(p) || CJK.test(p));
const canClose = (p: string, n: string, inner: string) =>
  !SPACE.test(p) &&
  (!PUNCT.test(p) || SPACE.test(n) || PUNCT.test(n) || CJK.test(n) || CJK.test(inner));
const CANDIDATE = /^\*\*(?!\*)((?:[^*\n`]|`[^`\n]*`)+?)\*\*(?!\*)/u;

// 放进 new Marked({ tokenizer: { emStrong(src, masked, prevChar = "") { ... } } })
const standard = Tokenizer.prototype.emStrong.call(this, src, masked, prevChar);
if (standard) return standard;
const m = CANDIDATE.exec(src);
if (!m) return undefined;
const inner = m[1];
const next = firstChar(src.slice(m[0].length));
if (!canOpen(lastChar(prevChar), firstChar(inner))) return undefined;
if (!canClose(lastChar(inner), next, inner)) return undefined;
if (!(CJK.test(lastChar(prevChar)) || CJK.test(next) || CJK.test(inner))) return undefined;
return { type: "strong", raw: m[0], text: inner, tokens: this.lexer.inlineTokens(inner) };
```

- 完成定义：04 的 C-1、C-2、C-3 通过。

### Stage 3：同步设计文档

- `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md`：字号阶梯补 17 和 20，注明这两档只给 Markdown 标题用。
- `docs/ohbaby-web/redesign-2026-10/05-components.md`：在 `MarkdownBlock` 的说明里补"通用样式在 `shared/markdown.css`，场景只定基准字号"和中文加粗兜底。
- 完成定义：文档和代码的数值一致。

## 2.5 兼容与迁移

没有数据和接口变化。用户能看到的变化是聊天字号小 1px、标题变小变整齐。文件预览的标题字号不变，标题间距略有调整，代码块从 12.5px 变成 13px。

## 2.6 风险与回滚

| 风险 | 应对 |
|---|---|
| 搬规则时漏掉或改变层叠顺序 | 按 04 的 S 组在聊天、文件预览、弹窗各看一遍 |
| 分词兜底误伤普通文本 | 只在标准规则失败时运行，并有 14 个"结果不变"的用例把关 |
| `marked` 升级后分词接口变化 | 单测会直接失败 |
| 同一段里有大量未闭合的 `**` | 这是 `marked` 现有的平方级耗时，81,000 字符约 10 秒。兜底只多约 1%，本议题不处理，流式议题记录了它的影响 |

两个 Stage 可以分别提交，出问题单独回退。

## 2.7 与其他议题的关系

本议题要先做。表格议题在 `shared/markdown.css` 上继续写表格规则；流式议题完成后，输出中的文字也用这套排版，并把 `firstChar`、`lastChar` 和分词配置移到共用渲染器；[Mermaid](../../../ohbaby-web/markdown-mermaid/goals-duty.md) 和 [LaTeX 公式](../../../ohbaby-web/markdown-math/goals-duty.md)的样式写进同一文件。

## 2.8 留到以后

暂无切出本轮的内容。`***粗斜体。***后面` 这类写法如果真实输出里常见，再考虑扩大兜底范围。
