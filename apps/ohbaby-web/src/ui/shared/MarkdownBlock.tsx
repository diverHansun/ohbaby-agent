import type { MouseEvent, ReactElement } from "react";
import { writeClipboard } from "./clipboard.js";
import { COPY_LABEL, COPY_TOKEN, renderMarkdown } from "./markdown-renderer.js";

const RESET_MS = 1500;

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
