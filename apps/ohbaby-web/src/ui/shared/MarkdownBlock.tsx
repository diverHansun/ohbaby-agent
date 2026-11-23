import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ClipboardEvent, MouseEvent, ReactElement } from "react";
import { writeClipboard } from "./clipboard.js";
import { COPY_LABEL, COPY_TOKEN, renderMarkdown } from "./markdown-renderer.js";
import { enhanceMermaidBlocks } from "./markdown-mermaid.js";
import { copyMathAsTex, enhanceMath } from "./markdown-math.js";
import { createMarkdownStream } from "./markdown-stream.js";

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

function onMathCopy(event: ClipboardEvent<HTMLDivElement>): void {
  copyMathAsTex(event.nativeEvent, event.currentTarget, COPY_TOKEN);
}

/**
 * `diagrams` draws the Mermaid blocks and `math` the LaTeX formulas once the
 * HTML is on the page. The same HTML string keeps React from rewriting the
 * DOM, so drawn diagrams, formulas and the code/diagram choice survive
 * re-renders; new text cancels the old work.
 */
export function MarkdownBlock(props: {
  readonly text: string;
  readonly diagrams?: boolean;
  readonly math?: boolean;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const math = props.math === true;
  const html = useMemo(
    () => renderMarkdown(props.text, { math }),
    [props.text, math],
  );
  const diagrams = props.diagrams === true;
  // Layout effect: with KaTeX loaded the formulas replace their placeholders
  // before the first paint.
  useLayoutEffect(() => {
    const node = container.current;
    if (!math || !node) return;
    return enhanceMath(node, COPY_TOKEN, { trackOverflow: true }).cancel;
  }, [html, math]);
  useEffect(() => {
    const node = container.current;
    if (!diagrams || !node) return;
    return enhanceMermaidBlocks(node, COPY_TOKEN).cancel;
  }, [html, diagrams]);
  return (
    // Clicks bubble here from the code blocks' own buttons, which keyboards
    // reach as ordinary buttons; the div itself is not a control.
    <div
      ref={container}
      className="ohb-markdown"
      onClick={onCodeCopy}
      onCopy={math ? onMathCopy : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Markdown for text still being written. Settled blocks are appended once and
 * left alone, so a selection in them survives; only the tail is replaced.
 * The children stay flat under `.ohb-markdown`, as in `MarkdownBlock`, which
 * takes over once the message completes. With `math`, a formula shows as soon
 * as it is closed; enhancing only fills placeholders, so the flat children
 * the stream counts stay the same.
 */
export function StreamingMarkdown(props: {
  readonly text: string;
  readonly math?: boolean;
}): ReactElement {
  const math = props.math === true;
  const container = useRef<HTMLDivElement>(null);
  const state = useRef({
    stream: createMarkdownStream({ math }),
    shown: undefined as string | undefined,
    frozen: 0,
  });

  // Layout effect: the conversation's auto-scroll runs right after this and
  // must see the new height in the same frame.
  useLayoutEffect(() => {
    const node = container.current;
    const current = state.current;
    if (!node) return;
    // StrictMode runs the effect twice with the same text.
    if (current.shown !== props.text) {
      current.shown = props.text;
      const update = current.stream.update(props.text);
      if (update.reset) current.frozen = 0;
      while (node.childNodes.length > current.frozen) node.lastChild?.remove();
      if (update.frozenHtml) {
        node.insertAdjacentHTML("beforeend", update.frozenHtml);
        current.frozen = node.childNodes.length;
      }
      node.insertAdjacentHTML("beforeend", update.tailHtml);
    }
    if (!math) return;
    return enhanceMath(node, COPY_TOKEN).cancel;
  }, [props.text, math]);

  return (
    <div
      ref={container}
      className="ohb-markdown"
      onClick={onCodeCopy}
      onCopy={math ? onMathCopy : undefined}
    />
  );
}
