import DOMPurify from "dompurify";
import { Marked, Renderer, Tokenizer } from "marked";
import type { MarkedExtension, Tokens } from "marked";
import { COPY_ICON } from "./markdown-icons.js";
import { isMermaidLang } from "./markdown-mermaid.js";
import {
  createMathExtension,
  isClosedFence,
  isMathLang,
  mathAttrs,
} from "./markdown-math-syntax.js";

/**
 * Markdown renders to one sanitized HTML string, so a code block's copy
 * button is part of that string and the container handles its clicks.
 *
 * The token marks the buttons this renderer wrote. Model output may carry raw
 * HTML that survives sanitizing (class, data-*, style), so a forged block could
 * show one command and copy a hidden one; a value it cannot know rules that
 * out. `getRandomValues` works without a secure context, unlike `randomUUID`.
 */
export const COPY_TOKEN = Array.from(
  globalThis.crypto.getRandomValues(new Uint8Array(12)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
const COPY_BUTTON = `<button type="button" class="ohb-code-copy" data-code-copy="${COPY_TOKEN}" aria-label="Copy code">${COPY_ICON}</button>`;

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
/**
 * The wrapper holds the button still while the code scrolls sideways. The
 * default output keeps escaping and the language class as they were.
 */
const codeBlock = (token: Tokens.Code, attrs = ""): string =>
  `<div class="ohb-code-block"${attrs}>${COPY_BUTTON}${defaults.code(token)}</div>`;

const options: MarkedExtension = {
  tokenizer: { emStrong: cjkStrong },
  renderer: {
    code(token): string {
      // A Mermaid block carries the page token, which forged HTML cannot.
      return codeBlock(
        token,
        isMermaidLang(token.lang) ? ` data-mermaid="${COPY_TOKEN}"` : "",
      );
    },
    /**
     * The wrapper scrolls so the table keeps table layout: three columns or
     * fewer fill the text width, four or more take their natural width and
     * scroll inside the wrapper, which keyboards can then focus.
     */
    table(token): string {
      const wide = token.header.length >= 4;
      const attrs = wide
        ? ' class="ohb-table-scroll is-wide" tabindex="0" role="region" aria-label="Scrollable table"'
        : ' class="ohb-table-scroll"';
      // The cells need this render's parser, which `defaults` does not have.
      return `<div${attrs}>${Renderer.prototype.table.call(this, token)}</div>`;
    },
  },
};

// Module instances, so no other `marked` user sees these renderers.
export const markdown = new Marked(options);
/**
 * Assistant text also reads LaTeX. A second instance, so every other caller
 * parses exactly as before.
 */
export const mathMarkdown = new Marked(options, {
  extensions: createMathExtension(COPY_TOKEN),
  renderer: {
    code(token): string | false {
      // An unclosed or empty block is still being written: plain code.
      if (!isMathLang(token.lang) || !isClosedFence(token.raw)) return false;
      if (!token.text.trim()) return false;
      return codeBlock(token, mathAttrs(COPY_TOKEN, token.text, true));
    },
  },
});

export function renderMarkdown(
  text: string,
  { math = false }: { readonly math?: boolean } = {},
): string {
  const parser = math ? mathMarkdown : markdown;
  return DOMPurify.sanitize(parser.parse(text, { async: false }));
}
