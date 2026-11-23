# LaTeX 公式：架构设计

> 前置：[goals-duty.md](goals-duty.md)。

## 1. Architecture Overview（架构概览）

解析时先把公式从 Markdown 里保护起来，写成带源码的占位元素。占位元素写入页面后，增强层按需加载 KaTeX，把它换成排好版的公式。

```
消息文本
   │
   ▼
公式语法层            识别五种写法，生成占位 HTML（不依赖 KaTeX）
   │  Markdown 渲染器调用
   ▼
Markdown 渲染层       解析、清洗，输出完成态或流式片段
   │  HTML
   ▼
消息视图              决定这段内容是否启用公式（只有助手文字）
   │  DOM
   ▼
公式增强层            找到真实占位，渲染、清洗、挂载、复制
   │  按需加载
   ▼
KaTeX（独立的懒加载包）
```

依赖只有一个方向。语法层进入首屏，KaTeX 只在增强层里动态导入，以后换渲染库只改增强层。

## 2. Design Pattern & Rationale（设计模式与理由）

采用**解析时保护、显示时增强**：

- 公式必须在 Markdown 处理 `_`、`*` 和 `\` 之前识别，所以用 `marked` 的分词扩展。
- KaTeX 约 76KB，不能进首屏，所以不能在同步的 Markdown 渲染器里直接调用。占位元素解决了这个矛盾。
- 占位元素本身就是源码。KaTeX 没加载好或渲染失败时，用户看到的仍是可读内容。

Mermaid 也用渐进增强，但两者的时机不同。半截 Mermaid 没法画，要等消息完成；公式闭合后就是完整内容，渲染一次约 0.1ms，可以在输出过程中显示。

## 3. Module Structure & File Layout（模块结构与文件布局）

路径相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。

```
shared/
├── markdown-math-syntax.ts       新增：五种写法的分词和占位 HTML
├── markdown-math-syntax.unit.test.ts
├── markdown-math.ts              新增：加载 KaTeX、渲染、缓存、挂载、选区复制
├── markdown-math.unit.test.ts
├── markdown-scroll-region.ts     和 Mermaid 共用，先实施的一方新建
├── markdown-renderer.ts          增加一个启用公式的 Marked 实例
├── markdown-stream.ts            支持公式模式，暂缓判断结尾的 $
├── MarkdownBlock.tsx             增加 math 开关，默认关闭
└── markdown.css                  公式字号、滚动和裁切
conversation/
└── MessageRow.tsx                给助手文字打开 math 开关

apps/ohbaby-web/vite.config.ts                 只保留 KaTeX 的 WOFF2 字体
packages/ohbaby-server/src/app/static-assets.ts  给 .woff2 返回 font/woff2
```

| 单元 | 负责 | 不负责 |
|---|---|---|
| 公式语法层 | 判断哪些文字是公式，输出占位 | 加载和调用 KaTeX |
| Markdown 渲染层 | 选择是否启用公式的 `Marked` 实例 | 判断消息是谁发的 |
| Markdown 组件 | 在 DOM 更新后启动和取消增强 | 公式语法 |
| 消息视图 | 决定哪些内容启用公式 | 渲染细节 |
| 公式增强层 | 渲染、清洗、挂载、缓存、选区复制 | Markdown 解析 |
| 样式 | 字号、滚动和裁切 | 公式内部排版（由 KaTeX 决定） |

## 4. Architectural Constraints & Trade-offs（架构约束与取舍）

约束：

- 没开 `math` 的调用方，解析结果必须和现在一样。
- 公式代码块不能改变 Copy 按钮和 `<pre>` 的父子关系，现有复制校验依赖它。
- 公式增强不能改变 `.ohb-markdown` 的顶层节点数量，流式更新靠这个数量定位结尾。
- KaTeX、样式和字体都由本站提供，不走 CDN，这样 Web 和 App 用同一份构建产物。

| 编号 | 决策 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| T1 | 用 KaTeX | VS Code、opencode、dsh、ZCode、kimi-code 都用它；同步、快，比 MathJax 小很多 | MathJax：Obsidian 在用，覆盖更广，但完整包约 275KB。Temml：更小，但显示依赖各浏览器的 MathML | `multline`、`\require` 等不支持 |
| T2 | 五种写法都读 | 模型不一定用 `$`，读取宽一些用户才看得到结果 | 只支持 `$` 和 `$$`：`\(...\)` 的括号会被 Markdown 吃掉 | 分词规则多两条 |
| T3 | 单个 `$` 用 Pandoc 风格边界，再加结尾 `$` 后不能接 `(`、`{` | 真实文档里的误判最少，能挡住 `${...}` 和 `$(...)` | VS Code 规则：`$ x $`、`${a} 和 ${b}` 这类会误判。ZCode 的启发式：规则多，`$HOME/$USER` 仍误判 | `$f$(x)` 这种紧贴写法不渲染 |
| T4 | 占位 + 增强 | KaTeX 可以懒加载，失败时不用额外处理 | 在 `marked` 渲染器里同步调用：KaTeX 要进首屏 | 有一小段命令式 DOM 操作 |
| T5 | 输出中闭合就显示 | 数学类回答不会先显示一大片源码，结束时也不会整体跳动 | 等消息完成（dsh）：实现更少，但长回答读起来很差 | 要处理结尾 `$` 和重复渲染 |
| T6 | 文本停在单个 `$` 上时暂不显示这个字符 | 等下一个字符才能判断是不是公式，`$5-$10` 不会闪成公式 | 不处理：测试里出现 6 次闪动 | 这个 `$` 晚一拍显示 |
| T7 | 按源码缓存渲染结果，最多 256 条 | 结尾块每次更新都重建。2,931 字符的公式单次更新从 18.3ms 降到 2.1ms | 不缓存：长公式会拖慢输出 | 多一个小 Map |
| T8 | 用两个 `Marked` 实例 | 其他调用方的解析结果不变 | 所有 Markdown 都识别公式：用户消息和文件预览也会变 | 配置要共用一份 |
| T9 | 源码放在 `data-tex` | DOMPurify 会去掉 KaTeX 的 `<annotation>`，不能靠它取回源码 | 放开 DOMPurify 的 MathML 限制：扩大攻击面 | DOM 里多一份源码 |
| T10 | KaTeX 输出再清洗一次 | 把渲染结果也当作不可信内容。44 个公式清洗前后布局相同 | 完全信任 KaTeX | 超长公式的主要耗时在这一步 |
| T11 | 单个公式最多 5,000 字符 | 实测最坏约 185ms；再长时生成的 HTML 和清洗成本明显增大 | 不限制：20,000 字符可以生成约 4MB HTML | 极长公式显示源码 |
| T12 | 行内公式字号 1.1em | 截图对比后最接近中文正文：1em 偏小，KaTeX 默认的 1.21em 偏大 | 默认 1.21em | 覆盖一条 KaTeX 样式 |
| T13 | 行内公式过宽时，所在段落横向滚动（dsh 的做法） | 保留 KaTeX 的基线和自动换行 | 把公式设为 `inline-block`：长公式不能在运算符处换行 | 段落会成为滚动容器 |
| T14 | 公式代码块渲染后保留 Copy | 用户问“这个公式的 LaTeX 怎么写”时，仍能一键拿到源码 | 去掉 Copy：`latex` 代码块的源码就拿不到了 | 代码块结构和 Mermaid 类似 |

### 和参考项目的对照

| 问题 | VS Code | Obsidian | opencode | deepseek-harness | ZCode | ohbaby |
|---|---|---|---|---|---|---|
| 渲染库 | KaTeX | MathJax | KaTeX | KaTeX | KaTeX（Streamdown） | KaTeX |
| 支持的写法 | `$`、`$$`、`math` 代码块 | `$`、`$$` | `$`、`$$`、`\(...\)`、`math`/`latex` 代码块 | `$`、`$$`、`\(...\)`、`\[...\]` | `$`、`$$` | 五种都支持 |
| `$` 判断 | 看前后字符 | 未公开细节 | Pandoc 风格 | remark-math 加兼容处理 | 启发式 | Pandoc 风格加两个结尾字符 |
| 输出过程中 | 不适用 | 不适用 | 实时渲染 | 结束后才渲染 | 实时渲染 | 闭合后显示 |
| 失败时 | 显示错误样式 | 显示错误 | 行内用错误样式，代码块保留源码 | 重试后显示错误文本 | 由 Streamdown 处理 | 保留源码 |
| 选区复制 | 未处理 | 不适用 | 未确认 | 复制 TeX 源码 | 未确认 | 复制 TeX 源码 |

识别边界主要借鉴 opencode，选区复制借鉴 dsh，字体裁剪思路也来自 dsh。输出过程中的显示时机和 dsh 不同，因为 ohbaby 的目标是长回答边输出边能读。
