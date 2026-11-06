import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";
import type { MouseEvent, ReactElement } from "react";
import { writeClipboard } from "./clipboard.js";

/**
 * Markdown renders to one sanitized HTML string, so a code block's copy
 * button is part of that string and the container handles its clicks. Its
 * label is text: icon components cannot live inside the HTML.
 */
const COPY_LABEL = "Copy";
const RESET_MS = 1500;

/**
 * Marks the buttons this renderer wrote. Model output may carry raw HTML that
 * survives sanitizing (class, data-*, style), so a forged block could show one
 * command and copy a hidden one; a value it cannot know rules that out.
 * `getRandomValues` works without a secure context, unlike `randomUUID`.
 */
const COPY_TOKEN = Array.from(
  globalThis.crypto.getRandomValues(new Uint8Array(12)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
const COPY_BUTTON = `<button type="button" class="ohb-code-copy" data-code-copy="${COPY_TOKEN}" aria-label="Copy code">${COPY_LABEL}</button>`;

const defaults = new Renderer();
// A module instance, so the code renderer touches no other `marked` user.
const markdown = new Marked({
  renderer: {
    code(token): string {
      // The default output keeps escaping and the language class as they were;
      // the wrapper holds the button still while the code scrolls sideways.
      return `<div class="ohb-code-block">${COPY_BUTTON}${defaults.code(token)}</div>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.parse(text, { async: false }));
}

/**
 * The code a genuine copy button belongs to: the `<pre>` that is its sibling
 * in the renderer's wrapper, without the newline Markdown appends.
 */
function codeBlockText(button: HTMLButtonElement): string | undefined {
  if (button.dataset.codeCopy !== COPY_TOKEN) return undefined;
  const block = button.parentElement;
  if (!block?.classList.contains("ohb-code-block")) return undefined;
  return block.querySelector(":scope > pre")?.textContent.replace(/\n$/u, "");
}

function showResult(button: HTMLButtonElement, copied: boolean): void {
  const label = copied ? "Copied" : "Copy failed";
  button.textContent = label;
  button.setAttribute("aria-label", label);
  button.dataset.copyState = copied ? "copied" : "failed";
  const previous = Number(button.dataset.resetTimer);
  if (previous) window.clearTimeout(previous);
  button.dataset.resetTimer = String(
    window.setTimeout(() => {
      button.textContent = COPY_LABEL;
      button.setAttribute("aria-label", "Copy code");
      delete button.dataset.copyState;
      delete button.dataset.resetTimer;
    }, RESET_MS),
  );
}

function onCodeCopy(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-code-copy]");
  if (!button || !event.currentTarget.contains(button)) return;
  const text = codeBlockText(button);
  if (text === undefined) return;
  void writeClipboard(text).then((copied) => {
    showResult(button, copied);
  });
}

export function MarkdownBlock(props: { readonly text: string }): ReactElement {
  return (
    // Clicks bubble here from the code blocks' own buttons, which keyboards
    // reach as ordinary buttons; the div itself is not a control.
    <div
      className="ohb-markdown"
      onClick={onCodeCopy}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text) }}
    />
  );
}
