import type { TokenizerAndRendererExtension, Tokens } from "marked";

/**
 * Finds LaTeX in assistant text before Markdown can read its `_`, `*` and `\`,
 * and writes a placeholder whose text is the formula as written and whose
 * `data-tex` is the source. KaTeX replaces it later (`markdown-math.ts`); this
 * file never loads KaTeX, so it is cheap enough for the first screen.
 *
 * The rules follow Pandoc: no space just inside a single `$`, and a closing
 * `$` must not touch a letter, digit, `(` or `{`, so prices and shell
 * variables stay text. Checked against marked 15.0.12.
 */
const INLINE_RULES = [
  // $$...$$ inside a line shows inline.
  /^\$\$(?=\S)((?:\\.|[^\\\n$])*?(?:\\\S|[^\s\\$]))\$\$/u,
  /^\$(?=[^\s$])((?:\\.|[^\\\n$])*?(?:\\\S|[^\s\\$]))\$(?![\w({])/u,
  /^\\\(((?:\\.|[^\\\n])+?)\\\)/u,
];

/** `$$...$$` or `\[...\]` on lines of their own. */
const BLOCK_RULE =
  /^ {0,3}(?:\$\$((?:(?!\$\$)[\s\S])+?)\$\$|\\\[((?:(?!\\\])[\s\S])+?)\\\])[ \t]*(?:\n+|$)/u;
/** Only a line start may open a block, so mid-line text is never cut. */
const BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)/u;

interface MathToken {
  readonly type: string;
  readonly raw: string;
  readonly text: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => ESCAPES[char] ?? char);

/** The attributes that make an element a formula this page wrote. */
export function mathAttrs(
  token: string,
  tex: string,
  display: boolean,
): string {
  return ` data-math="${token}" data-display="${display ? "1" : "0"}" data-tex="${escapeHtml(tex)}"`;
}

/** The first word of a code fence's info string is `math` or `latex`. */
export function isMathLang(lang: string | undefined): boolean {
  const word = lang?.trim().split(/\s/u, 1)[0]?.toLowerCase();
  return word === "math" || word === "latex";
}

/** Whether a fenced code token ends with its closing fence. */
export function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/u, "").split("\n");
  return (
    lines.length >= 2 &&
    /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/u.test(lines.at(-1) ?? "")
  );
}

/** The `marked` extensions for block and inline formulas. */
export function createMathExtension(
  token: string,
): TokenizerAndRendererExtension[] {
  return [
    {
      name: "mathBlock",
      level: "block",
      start(src): number | undefined {
        const match = BLOCK_START.exec(src);
        if (!match) return undefined;
        return match.index + (match[0].startsWith("\n") ? 1 : 0);
      },
      tokenizer(src): MathToken | undefined {
        const match = BLOCK_RULE.exec(src);
        if (!match) return undefined;
        return {
          type: "mathBlock",
          raw: match[0],
          // `$$` fills the first group, `\[` the second.
          text: ((match[1] as string | undefined) ?? match[2]).trim(),
        };
      },
      renderer(item: Tokens.Generic): string {
        return `<div class="ohb-math"${mathAttrs(token, String(item.text), true)}>${escapeHtml(item.raw.trim())}</div>`;
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(src): number | undefined {
        const index = src.search(/\$|\\\(/u);
        return index < 0 ? undefined : index;
      },
      tokenizer(src): MathToken | undefined {
        for (const rule of INLINE_RULES) {
          const match = rule.exec(src);
          if (match)
            return { type: "mathInline", raw: match[0], text: match[1] };
        }
        return undefined;
      },
      renderer(item: Tokens.Generic): string {
        return `<span class="ohb-math"${mathAttrs(token, String(item.text), false)}>${escapeHtml(item.raw)}</span>`;
      },
    },
  ];
}
