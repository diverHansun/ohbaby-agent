import DOMPurify from "dompurify";
import { Marked, Renderer, Tokenizer } from "marked";
import type { Tokens } from "marked";
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

/**
 * CommonMark only lets `**` open or close beside punctuation when a space or
 * more punctuation sits on the other side, which Chinese text never has:
 * `**注意：**内容` keeps its stars. When the standard rule finds nothing, this
 * retries one narrow case: a `**...**` pair without stars or line breaks
 * inside, with CJK text inside or right beside it. The open and close checks
 * follow deepseek-harness, so `2 ** 3` and glob paths stay as they are.
 */
const CJK =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /^\s?$/u;
const CANDIDATE = /^\*\*(?!\*)((?:[^*\n`]|`[^`\n]*`)+?)\*\*(?!\*)/u;

/** The last character of `text`; it reads only the end, so long lines stay cheap. */
export const lastChar = (text: string): string =>
  Array.from(text.slice(-2)).at(-1) ?? "";
/** The first character of `text`, reading only the start. */
export const firstChar = (text: string): string =>
  Array.from(text.slice(0, 2))[0] ?? "";

const canOpen = (prev: string, next: string): boolean =>
  !SPACE.test(next) &&
  (!PUNCT.test(next) || SPACE.test(prev) || PUNCT.test(prev) || CJK.test(prev));
const canClose = (prev: string, next: string, inner: string): boolean =>
  !SPACE.test(prev) &&
  (!PUNCT.test(prev) ||
    SPACE.test(next) ||
    PUNCT.test(next) ||
    CJK.test(next) ||
    CJK.test(inner));

function cjkStrong(
  this: Tokenizer,
  src: string,
  masked: string,
  prevChar = "",
): Tokens.Em | Tokens.Strong | undefined {
  const standard = Tokenizer.prototype.emStrong.call(
    this,
    src,
    masked,
    prevChar,
  );
  if (standard) return standard;
  const match = CANDIDATE.exec(src);
  if (!match) return undefined;
  const inner = match[1];
  const before = lastChar(prevChar);
  const next = firstChar(src.slice(match[0].length));
  if (!canOpen(before, firstChar(inner))) return undefined;
  if (!canClose(lastChar(inner), next, inner)) return undefined;
  if (!(CJK.test(before) || CJK.test(next) || CJK.test(inner)))
    return undefined;
  return {
    type: "strong",
    raw: match[0],
    text: inner,
    tokens: this.lexer.inlineTokens(inner),
  };
}

const defaults = new Renderer();
// A module instance, so the code renderer touches no other `marked` user.
const markdown = new Marked({
  tokenizer: { emStrong: cjkStrong },
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
