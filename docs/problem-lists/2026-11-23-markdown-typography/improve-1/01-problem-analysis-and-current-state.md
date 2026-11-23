# 1. 现状与问题分析

> 路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。行号是 2026-11-23 的快照。

## 1.1 现状

Web 端所有 Markdown 都经过 `shared/MarkdownBlock.tsx`：`marked` 解析，`DOMPurify` 清洗，再把 HTML 放进 `<div class="ohb-markdown">`。用到它的地方有三处：

| 位置 | 文件 | 外层字号 |
|---|---|---|
| 聊天消息（用户和助手） | `conversation/MessageRow.tsx:241` | 15px，压缩摘要 13px |
| 文件预览 | `side-panel/files/FilePreview.tsx:266` | 14px |
| 命令结果弹窗 | `commands/CommandResultModal.tsx` | 继承弹窗，里面的代码块会被通知样式盖住（见 1.5） |

组件只有一个，样式却分在两处：

```
MarkdownBlock（同一份 HTML）
├── 聊天：messages.css 只管段落、链接、代码，标题和列表走浏览器默认
├── 文件预览：files-page.css 有一整套标题、列表、引用、表格样式
└── 命令弹窗：两边的样式都只沾到一点
```

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 高 | 聊天里的标题没有样式 | 实测 H1 30px、H2 22.5px、H3 17.55px、H4 15px、H5 12.45px、H6 10.05px，字重 700。H5、H6 比正文还小 |
| P2 | 高 | 聊天正文偏离设计文档 | `messages.css:53` 是 15px，`docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` 写的是助手消息 14px |
| P3 | 高 | 完整样式只存在于文件预览 | `side-panel/files/files-page.css:258-334` 的规则都挂在 `.ohb-file-markdown` 下，聊天用不上 |
| P4 | 中 | 代码字号各说各的 | 行内代码 13px（`messages.css:125`），代码块 12.5px（`messages.css:555`），12.5 不在字号阶梯上 |
| P5 | 高 | 中文加粗失败 | `**注意：**内容` 原样显示星号。CommonMark 的分隔符规则要求标点旁边有空格或标点，中文正文不满足 |
| P6 | 中 | 聊天里的列表、引用、分隔线走浏览器默认 | 间距和正文节奏对不上，引用没有样式 |
| P7 | 低 | 用户气泡结尾不是段落时底部多一块空白 | `messages.css:74-77` 只清掉了 `p:last-child`，消息以列表或代码块结尾时外边距还在 |

## 1.3 根因

P1、P3、P6 是同一个原因：**排版样式挂在使用场景上，而不是挂在 Markdown 组件上。** 文件预览补了一套，聊天没补，新增场景也拿不到。P2 和 P4 是这个原因的副产物，没有统一入口，字号就各自漂移。

P5 是另一回事，出在解析层，CSS 修不了。

## 1.4 分维度诊断

| 维度 | 文档怎么说 | 代码怎么做 | 差距 |
|---|---|---|---|
| 职责 | `MarkdownBlock` 是唯一的 Markdown 入口 | 渲染统一，样式分散 | 样式也应该归它 |
| 结构 | 样式按功能拆分，由 `styles.css` 依次导入 | 通用 Markdown 规则放在 `conversation/` 和 `files/` 下 | 通用规则放错了目录 |
| 设计阶梯 | 字号 `10/11/12/13/14/15/22`，字重 400/500/600 | 12.5、17、20 不在阶梯上，标题字重 700 | 阶梯要补 17 和 20，12.5 要去掉 |
| 数据流 | 文本到 HTML 一条路 | 一致 | 无差距，中文加粗在 `marked` 分词这一步加兜底即可 |
| 安全 | HTML 必须经过 `DOMPurify` | 一致 | 本议题不改这条链路 |
| 性能 | 无明确指标 | 每次全量解析 | 分词兜底不能拖慢长文本。原型在 8 万字符的极端输入上只比 `marked` 自身慢约 1% |
| 测试 | 单测覆盖复制按钮等行为 | 没有中文加粗用例，也没有样式检查约定 | 中文加粗补单测，样式用浏览器验收 |

## 1.5 改动时要注意的现有行为

下面几条是读代码发现的约束，方案必须绕开：

1. **助手消息最后一段的 12px 下边距是有用的。** `.ohb-message-body > :last-child` 命中的是 `.ohb-markdown` 外层，所以里面最后一个 `<p>` 还留着 12px。文字和后面的工具行之间、文字和操作按钮之间，靠的都是这 12px（`ToolCard` 没有上边距，`.ohb-message-actions` 只有 2px）。如果照 opencode 把最后一个元素的边距清零，这些内容会贴在一起。
2. **`.ohb-message-body p` 不只管 Markdown。** 消息体里还有不是 Markdown 的 `<p>`，这条规则不能删。
3. **用户消息编辑框也是 15px**（`messages.css:647`）。正文改成 14px 后它要跟着改，否则点编辑时文字会跳一下。
4. **压缩摘要的基准是 13px。** 如果标题写死 px，摘要里的 H1 会比周围大太多，所以标题要跟着基准字号走。
5. **命令通知的 `pre` 规则会命中 Markdown 代码块。** `commands/notices.css:75` 写的是 `.ohb-command-notice pre`，命令结果里的代码块因此变成界面字体和 13.5px。通知自己的 `<pre>` 都是 `article` 的直接子元素，收窄成 `>` 不影响它们。
6. **触屏媒体查询里混着消息按钮和代码按钮。** `messages.css:606` 这一段同时管 `.ohb-message-actions` 和 `.ohb-code-copy`。整段搬走会让消息操作按钮在触屏上隐藏。
7. **`.ohb-markdown` 和 `.ohb-streaming-text` 共用 `overflow-wrap`。** `messages.css:136` 这条规则搬走时要给流式文本留一份，等流式议题接入后再删。
