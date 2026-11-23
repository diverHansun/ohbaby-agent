// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isClosedFence, isMathLang } from "./markdown-math-syntax.js";
import { COPY_TOKEN, renderMarkdown } from "./markdown-renderer.js";
import { createMarkdownStream } from "./markdown-stream.js";

interface Formula {
  readonly tex: string | undefined;
  readonly display: boolean;
  readonly codeBlock: boolean;
}

function page(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function formulasIn(html: string): Formula[] {
  return [...page(html).querySelectorAll<HTMLElement>("[data-math]")].map(
    (element) => ({
      tex: element.dataset.tex,
      display: element.dataset.display === "1",
      codeBlock: element.classList.contains("ohb-code-block"),
    }),
  );
}
const formulas = (text: string): Formula[] =>
  formulasIn(renderMarkdown(text, { math: true }));
const inline = (tex: string): Formula => ({
  tex,
  display: false,
  codeBlock: false,
});
const block = (tex: string): Formula => ({
  tex,
  display: true,
  codeBlock: false,
});

describe("math syntax", () => {
  it.each([
    ["Energy is $E = mc^2$.", ["E = mc^2"]],
    ["因此$x^2$是正数", ["x^2"]],
    ["$a_1$ and $b_1$.", ["a_1", "b_1"]],
    ["the $x$-axis", ["x"]],
    ["$x$'s value", ["x"]],
  ])("U-1: %j has inline formulas", (text, texs) => {
    expect(formulas(text)).toEqual(texs.map(inline));
  });

  it.each([
    ["\\(a_1 + b_1\\)", "a_1 + b_1"],
    ["a $$x$$ b", "x"],
  ])("U-2: %j is inline", (text, tex) => {
    expect(formulas(text)).toEqual([inline(tex)]);
  });

  it.each([
    ["$$\nx^2\n$$", "x^2"],
    ["$$x^2$$", "x^2"],
    ["\\[\n\\frac{a}{b}\n\\]", "\\frac{a}{b}"],
    ["\\[x\\]", "x"],
    ["- 列表\n\n  $$\n  y\n  $$", "y"],
    ["- $$z$$", "z"],
  ])("U-3: %j is a display formula", (text, tex) => {
    expect(formulas(text)).toEqual([block(tex)]);
  });

  it("U-3: a display formula splits the paragraph around it", () => {
    const div = page(
      renderMarkdown("前一段\n$$\nx\n$$\n后一段", { math: true }),
    );
    expect([...div.children].map((child) => child.tagName)).toEqual([
      "P",
      "DIV",
      "P",
    ]);
    expect(div.children[1].getAttribute("data-tex")).toBe("x");
  });

  it.each([
    "```math\nx^2\n```",
    "```LaTeX\nx^2\n```",
    '```latex title="Score"\nx^2\n```',
    "~~~latex\nx^2\n~~~",
  ])("U-4: %j is a formula code block", (text) => {
    expect(formulas(text)).toEqual([
      { tex: "x^2", display: true, codeBlock: true },
    ]);
  });

  it.each([
    "It costs $5 and $10.",
    "From $5-$10",
    "paid $5/$6.",
    "$1 和 $2 是参数",
  ])("U-5: %j has no formula", (text) => {
    expect(formulas(text)).toEqual([]);
  });

  it.each([
    "$HOME/$USER",
    "$PATH:$HOME",
    "$FOO$BAR",
    "${a} 和 ${b}",
    "$(id -u):$(id -g)",
  ])("U-6: %j has no formula", (text) => {
    expect(formulas(text)).toEqual([]);
  });

  it.each(["`$x$`", "```\n$x$\n```", "    $x$", "\\$x$", "$ x $"])(
    "U-7: %j has no formula",
    (text) => {
      expect(formulas(text)).toEqual([]);
    },
  );

  it.each([
    ["$a_1*b_2*c_3$", "a_1*b_2*c_3"],
    ["\\(x*y*z\\)", "x*y*z"],
  ])("U-8: %j keeps its stars", (text, tex) => {
    const html = renderMarkdown(text, { math: true });
    expect(html).not.toContain("<em>");
    expect(formulasIn(html)).toEqual([inline(tex)]);
  });

  it("U-9: formulas in table cells keep the columns", () => {
    const html = renderMarkdown(
      "| a | b |\n| --- | --- |\n| $x_1$ | $\\|x\\|$ |",
      { math: true },
    );
    expect(page(html).querySelectorAll("tbody td")).toHaveLength(2);
    expect(formulasIn(html).map((item) => item.tex)).toEqual(["x_1", "|x|"]);
  });

  it("U-10: other callers parse exactly as before", () => {
    const text = [
      "价格 $5 和 $x^2$，`code`，**粗体**",
      "",
      "$$\nx\n$$",
      "",
      "```math\nx\n```",
      "",
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    ].join("\n");
    const plain = renderMarkdown(text);
    expect(plain).not.toContain("data-math");
    expect(plain).toContain("$x^2$");
    expect(plain).toBe(renderMarkdown(text, { math: false }));
    // Without formulas the math parser writes the same bytes.
    const noMath = "# 标题\n\n段落 **粗** `code`\n\n```ts\nx\n```\n\n- a\n- b";
    expect(renderMarkdown(noMath, { math: true })).toBe(renderMarkdown(noMath));
  });

  it("U-11 (syntax): placeholders carry the page token and escape the source", () => {
    const div = page(renderMarkdown('$a<b \\text{"x"}$', { math: true }));
    const span = div.querySelector<HTMLElement>("span.ohb-math");
    expect(span?.dataset.math).toBe(COPY_TOKEN);
    expect(span?.dataset.tex).toBe('a<b \\text{"x"}');
    expect(span?.textContent).toBe('$a<b \\text{"x"}$');
  });

  it("isMathLang and isClosedFence", () => {
    expect(["math", "LaTeX", 'latex title="x"'].map(isMathLang)).toEqual([
      true,
      true,
      true,
    ]);
    expect(["mathx", "", undefined, "tex"].map(isMathLang)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(isClosedFence("```math\nx\n```\n")).toBe(true);
    expect(isClosedFence("```math\nx\n")).toBe(false);
    expect(isClosedFence("```math")).toBe(false);
  });
});

const DOCUMENT = [
  "# 公式",
  "",
  "质能方程 $E = mc^2$，以及 \\(a_1 + b_1\\) 和行内 $$x$$。",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "\\[",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "\\]",
  "",
  "```math",
  "\\sqrt{2}",
  "```",
  "",
  "价格从 $5-$10，变量 $HOME/$USER 不变。",
  "",
  "- 列表里 $y_1*y_2$",
  "",
  "最后一段。",
  "",
].join("\n");
const SIZES = [1, 2, 3, 5, 8, 13, 40, 200];

/** Streams `text` and records the DOM's formulas after every update. */
function streamed(text: string, size: number) {
  const stream = createMarkdownStream({ math: true });
  let frozen = "";
  const counts: number[] = [];
  let html = "";
  for (let end = size; ; end += size) {
    const update = stream.update(text.slice(0, end));
    if (update.reset) frozen = "";
    frozen += update.frozenHtml;
    html = frozen + update.tailHtml;
    counts.push(formulasIn(html).length);
    if (end >= text.length) break;
  }
  return { html, counts };
}

describe("streaming formulas", () => {
  it.each(SIZES)(
    "U-20: chunks of %i end equal to the full render, never losing a formula",
    (size) => {
      const { html, counts } = streamed(DOCUMENT, size);
      expect(html).toBe(renderMarkdown(DOCUMENT, { math: true }));
      for (let i = 1; i < counts.length; i++)
        expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
      expect(counts.at(-1)).toBe(7);
    },
  );

  it.each(["From $5-$10", "$HOME/$USER", "It costs $5 and $10."])(
    "U-21: typing %j never shows a formula",
    (text) => {
      expect(streamed(text, 1).counts.every((count) => count === 0)).toBe(true);
    },
  );

  it("U-21: a lone trailing $ waits, then shows", () => {
    const stream = createMarkdownStream({ math: true });
    expect(stream.update("价格 $").tailHtml).not.toContain("$");
    expect(stream.update("价格 $5").tailHtml).toContain("$5");
    const settled = createMarkdownStream({ math: true });
    expect(settled.update("double $$").tailHtml).toContain("$$");
    expect(settled.update("double $$ and \\$").tailHtml).toContain("and $");
  });

  it("U-22: a code block ending in $ is not held back", () => {
    const stream = createMarkdownStream({ math: true });
    expect(stream.update("```sh\necho $").tailHtml).toContain("echo $");
    expect(stream.update("```sh\necho $\n```").tailHtml).toContain("echo $");
  });

  it.each(["```math\nx^2", "```math\n```", "```latex\n   \n```"])(
    "U-23: %j stays a code block without a formula mark",
    (text) => {
      const html = createMarkdownStream({ math: true }).update(text).tailHtml;
      expect(html).toContain("ohb-code-block");
      expect(html).not.toContain("data-math");
      expect(formulas(text)).toEqual([]);
    },
  );
});
