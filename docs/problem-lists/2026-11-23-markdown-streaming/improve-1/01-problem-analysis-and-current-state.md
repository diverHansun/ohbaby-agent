# 1. 现状与问题分析

> 路径都相对 `apps/ohbaby-web/src/`，另有说明的除外。行号是 2026-11-23 的快照。

## 1.1 现状

```
daemon 事件 message.part.delta
   │
   ▼
api/daemon/eventReducer.ts   upsertTextPart：追加 delta，或用 content 整段替换
   │
   ▼
ui/conversation/MessageRow.tsx:238
   ├── 输出中：<pre class="ohb-streaming-text">原文</pre>
   └── 完成后：<MarkdownBlock text={原文} />
```

自动滚动的做法：`ConversationStream.tsx:538` 的 `messagesSignature` 包含文字长度，长度一变，`useLayoutEffect` 就用 `setTimeout(0)` 安排一次滚到底（`ConversationStream.tsx:551`、`:690`）。

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 高 | 输出中和完成后的样子完全不同 | 输出中是 13px 等宽字体（`ui/conversation/messages.css:162-166`），完成后是正文字体 |
| P2 | 高 | 完成瞬间内容跳动 | 标题、列表、表格、代码块在同一时刻改变高度和位置 |
| P3 | 中 | 输出中看不到结构 | 表格和列表都是源码，长回答要等结束才好读 |
| P4 | 中 | 直接换成 `MarkdownBlock` 会变慢 | 实测 6 万字符分 500 次输出，每次全量渲染 P95 为 26.6ms，累计 7070ms。一帧只有 16.7ms |

## 1.3 根因

P1 到 P3 的原因是输出过程走了另一条显示路径。之所以这样做，是因为现有渲染只能整段重算（P4）：回答越长，每次更新越贵，总成本随长度平方增长。

Markdown 的块级结构是按行推进的，新文字只会影响结尾的块，前面的块已经定型。所以只重算结尾就够了。

## 1.4 分维度诊断

| 维度 | 现状 | 差距 |
|---|---|---|
| 职责 | `MarkdownBlock.tsx` 同时放 `Marked` 配置、复制按钮和组件 | 增量逻辑需要共用 `Marked` 实例，配置要抽出来 |
| 数据流 | 文本一般是追加，但 `content` 字段可以整段替换 | 增量逻辑必须能识别并重置 |
| 性能 | 输出中不解析，几乎没有成本 | 接入后要守住单次更新的成本 |
| 安全 | 所有 HTML 都经过 `DOMPurify` | 分片渲染时每一片都要清洗 |
| 可靠性 | 完成后重新渲染，结果可信 | 这个特性要保留，作为增量结果的兜底 |

## 1.5 改动时要注意的现有行为

1. **文字可能被整段替换。** `eventReducer.ts` 的 `upsertTextPart` 支持 `content`，新文本不一定以旧文本开头。
2. **自动滚动依赖更新时机。** 子组件的 `useLayoutEffect` 先于父组件执行，父组件再用 `setTimeout(0)` 滚动。DOM 必须在子组件的 layout effect 里同步更新，推迟到下一帧就会滚得比内容早。
3. **`.ohb-streaming-text` 和其他元素共用规则。** `messages.css:137` 和 `.ohb-markdown` 共用 `overflow-wrap`，`:164`、`:180` 和工具面板共用字体和滚动。统一排版搬走 `.ohb-markdown` 后，第一处只剩它自己，可以整条删；后两处只能删这个选择器。
4. **多处测试用流式消息。** `App.unit.test.tsx`、`ConversationStream.unit.test.tsx`、`message-copy.unit.test.tsx`、`run-process.integration.test.tsx`、`SubagentConversationBody.unit.test.tsx` 都有 `status: "streaming"` 的数据，换结构后要跑一遍。
5. **DOM 不能多包一层。** 统一排版的规则依赖 `.ohb-markdown > :first-child` 和相邻标题选择器。给每个块包一个 React 容器，这些选择器就失效了。
6. **阅读位置只精确到消息行。** `ConversationStream.tsx` 的 `captureReadingRow` 只记录消息行的偏移。读者停在一条长回答的中段时，如果同一行上方的内容变高，`restoreReadingRow` 会把行顶放回原位，等于抵消了浏览器的滚动锚定，正在读的内容被推走。原型里上方变高 200px，阅读内容也偏移 200px。完成后的全量渲染、Mermaid 和公式都可能触发。
