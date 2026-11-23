# 数学公式：实施与验收记录

> 状态：2026-11-23 已实施并完成浏览器验收。所有 commit 都在本地分支 `feat/web-markdown`，没有 push，也没有合进 `main`。

## 1. 实际交付

按 `architecture.md` 和 `dfd-interface.md` 做完：

1. `ui/shared/markdown-math-syntax.ts` 是 `marked` 的块级和行内扩展，认出 `$...$`、`\(...\)`、`$$...$$`、`\[...\]`，以及闭合的 `math`、`latex` 代码块。它写出带 `data-math`（值是 `COPY_TOKEN`）、`data-display` 和 `data-tex` 的占位，占位的文字就是原文。`$` 的规则参照 Pandoc，价格和 shell 变量不算公式。
2. `markdown-renderer.ts` 有两个 `Marked` 实例：`markdown` 和 `mathMarkdown`。`renderMarkdown(text, { math })` 默认不开公式，现有调用方输出逐字节不变。
3. `markdown-stream.ts` 在 `math` 打开时用 `mathMarkdown`；结尾单独的一个 `$` 先不显示，等下一个字符再说。
4. `ui/shared/markdown-math.ts` 在第一次遇到公式时才加载 KaTeX（精确锁定 0.19.1）和它的 CSS。加载完以后增强是同步的，所以输出中的公式不会先闪源码。设置是 `throwOnError: true`、`strict: "ignore"`、`trust: false`、`maxSize: 10`、`maxExpand: 1000`，超过 5,000 字符不渲染。结果用 `DOMPurify` 清洗，并按显示模式和源码缓存 256 条，失败也缓存。
5. `MarkdownBlock` 和 `StreamingMarkdown` 新增 `math` 属性，默认关。`MessageRow` 只给助手消息（不含压缩摘要）打开。
6. 复制选区时，选中的公式换回 `$...$` 或 `$$...$$` 源码；选区一端落在公式里，就扩展到整个公式。这个做法借鉴了 deepseek-harness 的 `copy-tex.ts`。公式代码块的 Copy 仍然复制源码。
7. 构建时 `vite.config.ts` 的 `katexWoff2Only` 插件只保留 WOFF2 字体；daemon 的 `contentTypeForPath` 给 `.woff2` 返回 `font/woff2`。

## 2. 实施中的两处修正

**连续的独立公式复制时粘在一起。** 最初复制时把公式元素直接换成一个文字节点，两个相邻的独立公式会变成 `$$a$$$$b$$`。现在把独立公式换成一个 `<p>`，在纯文本和 HTML 里都各占一行。单测 U-26 加了对应的断言。

**读屏软件可能把公式读两遍。** `DOMPurify` 会删掉 KaTeX 的 `<annotation>` 标签（T9 已经接受这一点），但标签里的 LaTeX 源码会作为文字留在 `<math>` 里。现在清洗时加上 `ADD_FORBID_CONTENTS: ["annotation"]`，把内容一起删掉，其他输出不变。单测 U-12 加了一条，检查 `<math>` 里不再有多余的源码。

## 3. Commit

| Commit | 内容 |
|---|---|
| `10a19d84` | `feat(web): render LaTeX formulas in assistant answers` |
| `dd655ab2` | `docs(web): describe math formulas and add them to the Markdown mock` |
| `cdbda0fd` | `fix(web): keep formula source out of the MathML screen readers read` |

## 4. 自动化验证

| 检查 | 结果 |
|---|---|
| U-1 到 U-10、U-20 到 U-23 | `markdown-math-syntax.unit.test.ts`，54 个用例通过。U-20 用 8 种分块大小输入一篇含 7 个公式的文档，结果等于全量渲染，公式数量从不回退 |
| U-11 到 U-19、U-24 到 U-31 | `markdown-math.unit.test.tsx`，19 个用例通过，用的是真实的 KaTeX。U-30 用 `vi.doMock` 让 KaTeX 加载失败，确认只请求一次 |
| daemon | `create-app.unit.test.ts` 新增一条，确认 `.woff2` 返回 `font/woff2` |
| 全量 | Web 和 server 一共 151 个文件、1,925 个用例通过，1 个原本就跳过；类型检查和 lint 通过 |

## 5. 浏览器验收

在 `ohbaby-web-mock` 里用 Chrome 测。`?mock=markdown` 新增了“公式”一节，包含五种写法、价格和 shell 变量、一个很宽的公式、一个矩阵代码块和一个写错的公式。

| 编号 | 结果 |
|---|---|
| B-1 | 以 7 字符一块回放，每帧都检查：没有一帧出现未渲染的占位，公式数量从不减少 |
| B-2 | `$5-$10` 和 `$HOME/$USER` 一直是文字，回放中也没有出现单独留在行尾的 `$` |
| B-3 | 完成后 7 个公式都是 `ready`，写错的公式是 `error`，保留原文 |
| B-4 | 文件预览里没有公式占位；用户消息、命令结果由 `MessageRow` 的开关控制，U-31 测了默认关 |
| B-5 | 没有消息的页面不请求 KaTeX；构建产物里 KaTeX 是动态加载的独立包 |
| B-6 | 第一次出现公式时才请求 `katex.js` 和 `katex.min.css`，只下载了用到的 4 个 WOFF2 字体。`font/woff2` 由 daemon 单测验证，开发服务器不走 daemon |
| B-7 | 构建产物：`katex-*.js` 77.7KB、`katex-*.css` 7.7KB（都是 gzip 后），字体 19 个 WOFF2，没有 WOFF 和 TTF |
| B-8 | 行内公式 15.4px（正文 14px 的 1.1 倍），上下都在段落范围内，没有裁切 |
| B-9 | 375px 下宽公式内容 668px，在 327px 的框里滚动，加上 `role="region"`、`tabindex="0"` 和 `aria-label`，页面不横向滚动 |
| B-10 | 343px 容器里，长的行内公式在运算符处折成两行；不能断开的分式在段落内滚动（634px 内容放在 343px 里），页面不横向滚动 |
| B-11 | 桌面宽度下宽公式放得下，没有 `role`；手机宽度下溢出时才加上 |
| B-12 | 选中“公式”整节复制，得到 `$...$` 和 `$$...$$` 源码，连续两个独立公式各占一行；选区停在行内公式里时扩展到整个公式 |
| B-13 | 依赖流式议题 Stage 4 的块级阅读位置；KaTeX 加载后同步渲染，浏览器里没有单独测 |
| B-14 | 矩阵代码块显示成公式，Copy 复制出 LaTeX 源码并变成 Copied；触屏下 Copy 常显，不盖住公式 |
| B-15 | 只测了 Chrome |

控制台有一条 `ERR_CONNECTION_REFUSED`，来自 mock 环境的连接尝试，页面上所有资源都正常加载，和公式无关。

## 6. 没有验证的部分

- B-15 要求的 Edge、Safari、Firefox 都没测。
- B-13 没有在浏览器里手动测。
- 复制是在页面里派发 `copy` 事件测的，没有真的粘贴到别的应用里。
