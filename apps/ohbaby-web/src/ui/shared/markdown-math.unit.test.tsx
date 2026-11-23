// @vitest-environment jsdom
import katex from "katex";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock, StreamingMarkdown } from "./MarkdownBlock.js";
import { MATH_LIMIT, copyMathAsTex, enhanceMath } from "./markdown-math.js";
import { COPY_TOKEN, renderMarkdown } from "./markdown-renderer.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = vi.fn((_text: string) => Promise.resolve());
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  vi.restoreAllMocks();
  writeText.mockClear();
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

/** The math renderer's HTML for `text`, on the page and enhanced. */
async function enhanced(text: string): Promise<HTMLDivElement> {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(text, { math: true });
  document.body.append(div);
  await enhanceMath(div, COPY_TOKEN).done;
  return div;
}

const states = (root: ParentNode): (string | undefined)[] =>
  [...root.querySelectorAll<HTMLElement>("[data-math]")].map(
    (element) => element.dataset.mathState,
  );

function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

/** Fires a copy the way a browser would and returns what it wrote. */
function copy(
  root: HTMLElement,
  dispatch = false,
): { data: Map<string, string>; prevented: boolean } {
  const data = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (type: string, value: string) => data.set(type, value),
    },
  });
  if (dispatch) root.dispatchEvent(event);
  else copyMathAsTex(event as ClipboardEvent, root, COPY_TOKEN);
  return { data, prevented: event.defaultPrevented };
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function firstText(node: Node): Text {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode();
  if (!(text instanceof Text)) throw new Error("No text");
  return text;
}

describe("enhanceMath", () => {
  it("U-11: HTML a message wrote with a look-alike marker stays as it is", async () => {
    const root = await enhanced(
      '<span class="ohb-math" data-math="guess" data-display="0" data-tex="x">x</span>',
    );
    expect(root.querySelector("[data-math]")).not.toBeNull();
    expect(root.querySelector(".katex")).toBeNull();
    expect(states(root)).toEqual([undefined]);
  });

  it("U-12: a formula replaces its placeholder", async () => {
    const root = await enhanced("行内 $x^2$\n\n$$\n\\frac{a}{b}\n$$");
    expect(states(root)).toEqual(["ready", "ready"]);
    expect(root.querySelector("span.ohb-math > .katex")).not.toBeNull();
    expect(
      root.querySelector("div.ohb-math > .ohb-math-display > .katex-display"),
    ).not.toBeNull();
    // The flat children the stream counts stay the same.
    expect([...root.children].map((child) => child.tagName)).toEqual([
      "P",
      "DIV",
    ]);
  });

  it("U-13: errors keep their source; the other formulas render", async () => {
    const root = await enhanced(
      "$\\notacommand{x}$ 和 $y_1$\n\n$$\n\\frac{1}{\n$$",
    );
    expect(states(root)).toEqual(["error", "ready", "error"]);
    const [bad, , open] = root.querySelectorAll("[data-math]");
    expect(bad.textContent).toBe("$\\notacommand{x}$");
    expect(open.textContent).toBe("$$\n\\frac{1}{\n$$");
  });

  it("U-14: the limit decides whether KaTeX is called", async () => {
    const render = vi.spyOn(katex, "renderToString");
    const at = "a".repeat(MATH_LIMIT);
    await enhanced(`$${at}$`);
    expect(render).toHaveBeenCalledTimes(1);
    const root = await enhanced(`$${at}b$`);
    expect(render).toHaveBeenCalledTimes(1);
    expect(states(root)).toEqual(["error"]);
  });

  it("U-15: trusted commands make no links, images, ids, handlers or styles", async () => {
    const root = await enhanced(
      [
        "$\\href{javascript:alert(1)}{x}$",
        "$\\url{https://evil.example}$",
        "$\\includegraphics{https://evil.example/x.png}$",
        "$\\htmlClass{evil}{x}$",
        "$\\htmlId{evil}{x}$",
        "$\\htmlStyle{color:red}{x}$",
        "$\\htmlData{foo=bar}{x}$",
      ].join(" "),
    );
    expect(root.querySelector("a, img, [id], [data-foo], .evil")).toBeNull();
    // `data-tex` keeps the source; only KaTeX's output must be inert.
    for (const element of root.querySelectorAll(".katex, .katex *"))
      for (const name of element.getAttributeNames()) {
        expect(name).not.toMatch(/^on/iu);
        expect(element.getAttribute(name)).not.toMatch(
          /javascript:|evil\.example|color:\s*red/iu,
        );
      }
    expect(root.innerHTML).not.toMatch(/#cc0000/iu);
  });

  it("U-16: runaway macros and deep nesting keep their source", async () => {
    const root = await enhanced(
      [
        "$\\def\\a{\\a}\\a$",
        "$\\def\\a{xx}\\def\\b{\\a\\a}\\def\\c{\\b\\b}\\def\\d{\\c\\c}\\def\\e{\\d\\d}\\def\\f{\\e\\e}\\def\\g{\\f\\f}\\def\\h{\\g\\g}\\def\\i{\\h\\h}\\def\\j{\\i\\i}\\def\\k{\\j\\j}\\k$",
        `$${"{".repeat(3000)}x${"}".repeat(3000)}$`,
      ].join(" "),
    );
    expect(states(root)).toEqual(["error", "error", "error"]);
  });

  it("U-17: rule sizes are capped", async () => {
    const root = await enhanced("$\\rule{100000em}{100000em}$");
    expect(states(root)).toEqual(["ready"]);
    const styles = [...root.querySelectorAll(".katex-html [style]")]
      .map((element) => element.getAttribute("style"))
      .join(";");
    const sizes = [...styles.matchAll(/([\d.]+)em/gu)].map((match) =>
      Number(match[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10.5);
  });

  it("U-18: Chinese inside a formula renders", async () => {
    const root = await enhanced("$速度=\\frac{路程}{时间}$");
    expect(states(root)).toEqual(["ready"]);
    expect(root.querySelector(".katex")?.textContent).toContain("路程");
  });

  it("U-19: the same formula renders once", async () => {
    const render = vi.spyOn(katex, "renderToString");
    await enhanced("$\\sqrt{19}$");
    const root = await enhanced("$\\sqrt{19}$");
    expect(render).toHaveBeenCalledTimes(1);
    expect(states(root)).toEqual(["ready"]);
  });
});

describe("copying formulas", () => {
  it("U-24: Copy on a formula code block gives the LaTeX source", async () => {
    const { container } = mount(
      <MarkdownBlock text={"```math\n\\sum_i x_i\n```"} math />,
    );
    await vi.waitFor(() => {
      expect(states(container)).toEqual(["ready"]);
    });
    expect(container.querySelector("pre")?.hidden).toBe(true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".ohb-code-copy")?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("\\sum_i x_i");
  });

  it("U-25: a selection ending inside a formula copies all of it", async () => {
    const root = await enhanced("前面的文字 $x^2$ 后面");
    const paragraph = root.querySelector("p");
    const formula = root.querySelector(".katex-html");
    if (!paragraph || !formula) throw new Error("Missing nodes");
    select(firstText(paragraph), 2, firstText(formula), 0);
    const { data, prevented } = copy(root);
    expect(prevented).toBe(true);
    expect(data.get("text/plain")).toBe("的文字 $x^2$");
    expect(data.get("text/html")).toContain("$x^2$");
    // The page's own selection is unchanged.
    expect(document.getSelection()?.getRangeAt(0).endContainer).toBe(
      firstText(formula),
    );
  });

  it("U-26: display formulas and formula code blocks copy as $$...$$", async () => {
    const { container } = mount(
      <MarkdownBlock
        text={"段落\n\n$$\na+b\n$$\n\n```math\nc\n```\n\n结尾"}
        math
      />,
    );
    await vi.waitFor(() => {
      expect(states(container)).toEqual(["ready", "ready"]);
    });
    const markdown = container.querySelector<HTMLElement>(".ohb-markdown");
    if (!markdown) throw new Error("Missing Markdown");
    select(markdown, 0, markdown, markdown.childNodes.length);
    const { data } = copy(markdown, true);
    const text = data.get("text/plain") ?? "";
    expect(text).toContain("$$a+b$$");
    expect(text).toContain("$$c$$");
    expect(text).not.toContain("Copy");
    // Each display formula keeps its own line.
    expect(data.get("text/html")).toContain("<p>$$a+b$$</p>");
    expect(data.get("text/html")).toContain("<p>$$c$$</p>");
  });

  it("U-27: selections without rendered formulas keep the default copy", async () => {
    const root = await enhanced("普通文字\n\n坏公式 $\\notacommand$");
    const [plain, broken] = root.querySelectorAll("p");
    select(firstText(plain), 0, firstText(plain), 2);
    expect(copy(root)).toEqual({ data: new Map(), prevented: false });
    select(broken, 0, broken, broken.childNodes.length);
    expect(copy(root)).toEqual({ data: new Map(), prevented: false });
  });
});

describe("Markdown components with math", () => {
  it("U-28: StrictMode, an unchanged re-render and new content", async () => {
    const { container, root } = mount(
      <StrictMode>
        <MarkdownBlock text="一 $a_1$" math />
      </StrictMode>,
    );
    await vi.waitFor(() => {
      expect(states(container)).toEqual(["ready"]);
    });
    const first = container.querySelector(".katex");
    act(() => {
      root.render(
        <StrictMode>
          <MarkdownBlock text="一 $a_1$" math />
        </StrictMode>,
      );
    });
    expect(container.querySelector(".katex")).toBe(first);
    act(() => {
      root.render(
        <StrictMode>
          <MarkdownBlock text="二 $b_2$" math />
        </StrictMode>,
      );
    });
    await vi.waitFor(() => {
      expect(states(container)).toEqual(["ready"]);
    });
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(
      container.querySelector("[data-tex]")?.getAttribute("data-tex"),
    ).toBe("b_2");
  });

  it("shows a streamed formula once it is closed, keeping the flat children", async () => {
    // Loaded by the tests above, so the stream enhances in the same frame.
    await enhanced("$x$");
    const { container, root } = mount(
      <StreamingMarkdown text="式子 $x" math />,
    );
    const markdown = container.querySelector(".ohb-markdown");
    expect(states(container)).toEqual([]);
    act(() => {
      root.render(
        <StreamingMarkdown text={"式子 $x^2$ 写完\n\n下一段"} math />,
      );
    });
    expect(states(container)).toEqual(["ready"]);
    expect(markdown?.children).toHaveLength(2);
  });

  it("U-31: MarkdownBlock reads no formulas by default", () => {
    const { container } = mount(<MarkdownBlock text="价格 $x^2$" />);
    expect(container.querySelector("[data-math]")).toBeNull();
    expect(container.textContent.trim()).toBe("价格 $x^2$");
  });
});

describe("loading KaTeX", () => {
  afterEach(() => {
    vi.doUnmock("katex");
    vi.resetModules();
  });

  it("U-29: a run cancelled before KaTeX loads writes nothing", async () => {
    vi.resetModules();
    const fresh = await import("./markdown-math.js");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("$x$", { math: true });
    const task = fresh.enhanceMath(root, COPY_TOKEN);
    task.cancel();
    await task.done;
    expect(states(root)).toEqual([undefined]);
    expect(root.textContent.trim()).toBe("$x$");
  });

  it("U-30: a failed load keeps the source and is not retried", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("katex", () => {
      loads++;
      throw new Error("offline");
    });
    const fresh = await import("./markdown-math.js");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("$x$ $y$", { math: true });
    await expect(
      fresh.enhanceMath(root, COPY_TOKEN).done,
    ).resolves.toBeUndefined();
    await fresh.enhanceMath(root, COPY_TOKEN).done;
    expect(states(root)).toEqual([undefined, undefined]);
    expect(root.textContent.trim()).toBe("$x$ $y$");
    expect(loads).toBe(1);
  });
});
