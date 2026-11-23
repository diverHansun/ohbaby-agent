import type { UiMessage, UiSnapshot } from "ohbaby-sdk";
import type { createOhbabyWebStore } from "../store/store.js";

/**
 * `?mock=markdown` shows one finished answer that uses every Markdown element
 * the Web renders. Add `&stream=1` to replay a second answer in chunks
 * (`&chunk=<chars>`, `&ms=<interval>`), so streaming, the completion switch
 * and scrolling can be checked without a model.
 */
export const MARKDOWN_SAMPLE = [
  "# 渲染总览",
  "## 排版",
  "这是一段正文，含有**注意：**中文加粗、`inline code` 和一个[链接](https://example.com)。**事件中间件（waterfall）**实现了顺序调用，2 ** 3 和 `src/**/*.ts` 保持原样。",
  "",
  "### 列表",
  "- 第一项，带**重点**",
  "- 第二项",
  "  - 嵌套项 A",
  "  - 嵌套项 B",
  "- 第三项",
  "",
  "1. 先读代码",
  "2. 再写方案",
  "3. 最后实施",
  "",
  "#### 四级标题",
  "> 引用里的一段话，颜色更淡。",
  ">",
  "> 第二段引用。",
  "",
  "##### 五级标题",
  "###### 六级标题",
  "代码块：",
  "",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  return a + b; // **not bold**",
  "}",
  "```",
  "",
  "---",
  "",
  "## 表格",
  "| 方案 | 体积 | 说明 |",
  "| --- | --: | :-: |",
  "| Pele | 2.25 MB | 按需加载 |",
  "| Mermaid | 14.7 MB | 官方实现 |",
  "",
  "| 项目 | 语言 | 解析器 | 表格策略 | 流式 | 公式 | 图表 | 备注 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| dsh | TypeScript | micromark | 少于 4 列铺满，4 列及以上按内容自然撑开 | 冻结前面的块 | KaTeX | 插件 | 这一格故意写得很长，用来检查单元格在 320px 处换行而不是一字一行 |",
  "| opencode | TypeScript | patchmark | 外框内滚动 | 自研增量 | KaTeX | Pele | https://example.com/a/very/long/url/that/should/wrap/somewhere/inside/the/cell |",
  "",
  "<table><tr><td>原始 HTML 表格</td><td>第二列内容很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长</td><td>third</td></tr></table>",
  "",
  "参考式链接：见 [设计文档][design]。",
  "",
  "[design]: https://example.com/design",
].join("\n");

const iso = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const finished: readonly UiMessage[] = [
  {
    id: "md_u1",
    role: "user",
    createdAt: iso(6),
    parts: [{ type: "text", text: "演示一下 Markdown 渲染" }],
  },
  {
    id: "md_a1",
    role: "assistant",
    createdAt: iso(6),
    status: "completed",
    parts: [{ type: "text", text: MARKDOWN_SAMPLE }],
  },
];

const replay: readonly UiMessage[] = [
  {
    id: "md_u2",
    role: "user",
    createdAt: iso(1),
    parts: [{ type: "text", text: "再来一次，边输出边显示" }],
  },
  {
    id: "md_a2",
    role: "assistant",
    createdAt: iso(1),
    status: "streaming",
    parts: [{ type: "text", text: "" }],
  },
];

function streaming(): boolean {
  return new URLSearchParams(location.search).get("stream") === "1";
}

export function markdownMessages(): readonly UiMessage[] {
  return streaming() ? [...finished, ...replay] : finished;
}

/** Streams the replayed answer through the same events the daemon sends. */
export function startMarkdownReplay(
  store: ReturnType<typeof createOhbabyWebStore>,
  snapshot: UiSnapshot,
): void {
  if (!streaming() || !snapshot.activeSessionId) return;
  const sessionId = snapshot.activeSessionId;
  const params = new URLSearchParams(location.search);
  const chunk = Math.max(1, Number(params.get("chunk") ?? 12));
  const interval = Math.max(1, Number(params.get("ms") ?? 30));
  // Reopening the session reinstalls this snapshot; keep it up to date, as
  // the daemon's would be, so the answer does not start over.
  const session = snapshot.sessions.find((entry) => entry.id === sessionId) as
    | { messages: readonly UiMessage[] }
    | undefined;
  const sync = (message: UiMessage): void => {
    if (!session) return;
    session.messages = session.messages.map((entry) =>
      entry.id === message.id ? message : entry,
    );
  };
  let offset = 0;
  let seq = 2;
  const timer = window.setInterval(() => {
    const delta = MARKDOWN_SAMPLE.slice(offset, offset + chunk);
    offset += chunk;
    if (delta) {
      sync({
        ...replay[1],
        parts: [{ type: "text", text: MARKDOWN_SAMPLE.slice(0, offset) }],
      });
      store.applyEvent(
        { type: "message.part.delta", sessionId, messageId: "md_a2", delta },
        seq++,
      );
      return;
    }
    window.clearInterval(timer);
    const message: UiMessage = {
      ...replay[1],
      status: "completed",
      parts: [{ type: "text", text: MARKDOWN_SAMPLE }],
    };
    sync(message);
    store.applyEvent({ type: "message.updated", sessionId, message }, seq++);
  }, interval);
}
