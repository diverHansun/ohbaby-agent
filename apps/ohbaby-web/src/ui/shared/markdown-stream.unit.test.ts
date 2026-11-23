// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-renderer.js";
import { createMarkdownStream } from "./markdown-stream.js";

const DOCUMENT = [
  "# 标题",
  "",
  "第一段，含有**重点**和 `code`。",
  "",
  "Setext 标题",
  "-----------",
  "",
  "- 第一项",
  "- 第二项",
  "  - 嵌套",
  "",
  "1. 一",
  "2. 二",
  "",
  "> 引用一行",
  "> 引用两行",
  "",
  "| a | b |",
  "| --- | --: |",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "```ts",
  "const x = 2 ** 3; // **not bold** `tick`",
  "```",
  "",
  "最后一段。",
  "",
].join("\n");

const SIZES = [1, 2, 3, 5, 8, 13, 40, 200];

/** Streams `text` in `size` chunks and returns what the DOM would hold. */
function streamed(text: string, size: number) {
  const stream = createMarkdownStream();
  const frozen: string[] = [];
  let tail = "";
  let resets = 0;
  for (let end = size; ; end += size) {
    const update = stream.update(text.slice(0, end));
    if (update.reset) resets++;
    if (update.frozenHtml) frozen.push(update.frozenHtml);
    tail = update.tailHtml;
    if (end >= text.length) break;
  }
  return { html: frozen.join("") + tail, frozen, resets };
}

/** Every prefix's rendering, as text the reader sees. */
function prefixes(text: string): { prefix: string; html: string }[] {
  const out = [];
  for (let end = 1; end <= text.length; end++) {
    const update = createMarkdownStream().update(text.slice(0, end));
    out.push({ prefix: text.slice(0, end), html: update.tailHtml });
  }
  return out;
}

const shownText = (html: string): string => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent;
};

describe("createMarkdownStream", () => {
  it.each(SIZES)("U-1: %i-char chunks end equal to a full render", (size) => {
    const result = streamed(DOCUMENT, size);
    expect(result.html).toBe(renderMarkdown(DOCUMENT));
    expect(result.resets).toBe(0);
    expect(result.frozen.length).toBeGreaterThan(0);
  });

  it("U-2: frozen fragments are handed out once", () => {
    const stream = createMarkdownStream();
    const first = stream.update(DOCUMENT);
    expect(first.frozenHtml).not.toBe("");
    // StrictMode re-runs the effect with the same text.
    const again = stream.update(DOCUMENT);
    expect(again.frozenHtml).toBe("");
    expect(again.tailHtml).toBe(first.tailHtml);
    const more = stream.update(DOCUMENT + "\n新的一段。");
    expect(more.frozenHtml).not.toContain("第一段");
  });

  it("U-3: replaced text resets and renders only the new text", () => {
    const stream = createMarkdownStream();
    stream.update(DOCUMENT);
    const update = stream.update("完全不同的内容");
    expect(update.reset).toBe(true);
    expect(update.frozenHtml).toBe("");
    expect(update.tailHtml).toBe(renderMarkdown("完全不同的内容"));
  });

  it.each([
    "```js\nconst a = 2 ** 3;\nlet s = `x",
    "- 列表\n  ```js\n  const a = **b\n  let s = `x",
    "> 引用\n> ```\n> **未闭合 `tick",
  ])("U-4: an open fence stays code, untouched: %j", (text) => {
    const code = (html: string) =>
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector("pre code");
    for (const { prefix, html } of prefixes(text)) {
      const full = code(renderMarkdown(prefix));
      if (!full) continue;
      // Healing never reaches into code: it reads exactly as a full render.
      expect(code(html)?.textContent, prefix).toBe(full.textContent);
      expect(html, prefix).not.toContain("<strong>");
    }
  });

  it.each([
    "2 ** 3 ** 4",
    "a ** b",
    "2**31 是上限",
    "x**2 + y**2",
    "路径 src/**/*.ts 和 lib/**/*.js",
  ])("U-5: healing turns no prefix of %j bold", (text) => {
    // `x**2 + y**2` is bold in CommonMark itself; healing must add none.
    const strong = (html: string) => html.split("<strong>").length - 1;
    for (const { prefix, html } of prefixes(text)) {
      expect(strong(html), prefix).toBeLessThanOrEqual(
        strong(renderMarkdown(prefix)),
      );
    }
    expect(strong(createMarkdownStream().update("2**31 是上限").tailHtml)).toBe(
      0,
    );
  });

  it.each([
    "**注意：**内容",
    "这是**重点。**后面",
    "使用**`pnpm`**安装",
    "- 列表 **重点** 结束",
    "## 标题 **重点**",
    "| a | b |\n| --- | --- |\n| 1 | **b** |",
  ])("U-6: no prefix of %j shows a star", (text) => {
    for (const { prefix, html } of prefixes(text)) {
      expect(shownText(html), prefix).not.toContain("*");
    }
    expect(createMarkdownStream().update(text).tailHtml).toContain("<strong>");
  });

  it("U-7: a half-typed code span shows as code; a bare backtick hides", () => {
    const stream = () => createMarkdownStream();
    expect(stream().update("运行 `pnpm").tailHtml).toContain(
      "<code>pnpm</code>",
    );
    const bare = stream().update("运行 `").tailHtml;
    expect(shownText(bare)).not.toContain("`");
    expect(shownText(stream().update("运行 ``a").tailHtml)).not.toContain("`");
  });

  it("U-8: event handlers are sanitized from the tail", () => {
    const text = "正文\n\n<img src=x onerror=alert(1)>";
    const handlers = (html: string) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return [...div.querySelectorAll("*")].filter((el) =>
        el.getAttributeNames().some((name) => name.startsWith("on")),
      );
    };
    for (const { prefix, html } of prefixes(text)) {
      expect(handlers(html), prefix).toEqual([]);
    }
    const final = createMarkdownStream().update(text).tailHtml;
    expect(final).toContain("<img");
    const frozen = streamed(`<img src=x onerror=alert(1)>\n\n${DOCUMENT}`, 7);
    expect(frozen.frozen.join("")).toContain("<img");
    expect(handlers(frozen.html)).toEqual([]);
  });

  it.each(SIZES)(
    "U-9: link definitions at the start and middle, %i-char chunks",
    (size) => {
      const text = [
        "[start]: https://example.com/start",
        "",
        "见 [开头][start] 和 [中间][mid]。",
        "",
        DOCUMENT,
        "[mid]: https://example.com/mid",
        "",
        "又一段，引用 [中间][mid]。",
        "",
        "结尾段落。",
      ].join("\n");
      const result = streamed(text, size);
      expect(result.html).toBe(renderMarkdown(text));
      expect(result.frozen).toEqual([]);
    },
  );

  it("U-9: freezing stops once a definition appears", () => {
    const text = `${DOCUMENT}\n[mid]: https://example.com/mid\n\n${DOCUMENT}`;
    const result = streamed(text, 13);
    expect(result.html).toBe(renderMarkdown(text));
    expect(result.frozen.join("")).not.toContain("example.com");
    expect(result.frozen.length).toBeGreaterThan(0);
  });
});
