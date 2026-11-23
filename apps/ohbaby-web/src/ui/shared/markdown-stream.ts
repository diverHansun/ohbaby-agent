import DOMPurify from "dompurify";
import type { Token } from "marked";
import { firstChar, lastChar, markdown } from "./markdown-renderer.js";

/**
 * One streamed update: `frozenHtml` is appended once and never touched again,
 * `tailHtml` replaces the previous tail. `reset` means the text was replaced
 * rather than extended, so everything shown so far must go.
 */
export interface MarkdownStreamUpdate {
  readonly reset: boolean;
  readonly frozenHtml: string;
  readonly tailHtml: string;
}

/** Blocks kept in the tail: new text rewrites at most the last one. */
const TAIL_BLOCKS = 2;

/**
 * Renders a growing Markdown text without re-parsing what is settled. All but
 * the last two top-level blocks are frozen; the tail is parsed again on every
 * update with half-typed `**` and backticks closed on its last line. Both
 * parts are sanitized on their own before they reach the DOM.
 */
export function createMarkdownStream(): {
  update(text: string): MarkdownStreamUpdate;
} {
  let previous = "";
  let frozenEnd = 0;
  return {
    update(text) {
      const reset = !text.startsWith(previous);
      if (reset) frozenEnd = 0;
      previous = text;

      const source = text.slice(frozenEnd);
      const tokens: Token[] = markdown.lexer(source);
      const blocks = tokens.flatMap((token, index) =>
        token.type === "space" ? [] : [index],
      );
      const keepFrom =
        blocks.length > TAIL_BLOCKS ? (blocks.at(-TAIL_BLOCKS) ?? 0) : 0;

      let frozenHtml = "";
      let tailTokens = tokens;
      let tailSource = source;
      if (keepFrom > 0) {
        const frozen = tokens.slice(0, keepFrom);
        const raw = frozen.map((token) => token.raw).join("");
        // Link definitions leave no token, so their text is missing from
        // `raw`; freezing would then cut at the wrong place. Keep it all in
        // the tail instead.
        if (source.startsWith(raw)) {
          frozenHtml = DOMPurify.sanitize(markdown.parser(frozen));
          frozenEnd += raw.length;
          tailTokens = tokens.slice(keepFrom);
          tailSource = source.slice(raw.length);
        }
      }
      const healed = closeOpenMarkers(tailSource, tailTokens);
      const tailHtml = DOMPurify.sanitize(
        healed === tailSource
          ? markdown.parser(tailTokens)
          : markdown.parse(healed, { async: false }),
      );
      return { reset, frozenHtml, tailHtml };
    },
  };
}

const FENCE = /^ {0,3}(?:[-*+]\s+|\d+[.)]\s+|>\s?)*(`{3,}|~{3,})/u;

/** Whether `raw` ends inside a fenced code block, at any nesting depth. */
function insideFence(raw: string): boolean {
  let open = "";
  for (const line of raw.split("\n")) {
    const fence = FENCE.exec(line.trimStart())?.[1];
    if (!fence) continue;
    if (!open) open = fence;
    else if (fence.startsWith(open[0]) && fence.length >= open.length)
      open = "";
  }
  return open !== "";
}

/**
 * Closes a half-typed `**` or code span on the last line, so the reader sees
 * bold or code instead of stars and backticks. Code and HTML stay exactly as
 * written.
 */
export function closeOpenMarkers(
  source: string,
  tokens: readonly Token[],
): string {
  const last = tokens.filter((token) => token.type !== "space").at(-1);
  if (!last || last.type === "code" || last.type === "html") return source;
  if (insideFence(last.raw)) return source;
  const start = source.lastIndexOf("\n") + 1;
  const line = source.slice(start);
  const closed = closeLine(line);
  return closed === line ? source : source.slice(0, start) + closed;
}

/** What may follow an opening `**`: text, a code span or an opening quote. */
const OPEN_NEXT = /[\p{L}\p{N}`“‘「『（([]/u;
/** A Latin letter or digit right before `**` means `2**31`, not bold. */
const WORD_BEFORE = /[\p{Script=Latin}\p{N}]/u;

export function closeLine(line: string): string {
  let bold = -1;
  let tick = 0;
  let tickAt = -1;
  let skip = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (line[i + n] === "`") n++;
      if (!tick) {
        tick = n;
        tickAt = i;
      } else if (tick === n) {
        tick = 0;
        tickAt = -1;
      }
      i += n;
      continue;
    }
    if (
      !tick &&
      c === "*" &&
      line[i + 1] === "*" &&
      line[i + 2] !== "*" &&
      line[i - 1] !== "*"
    ) {
      if (bold >= 0) bold = -1;
      else if (skip) skip = false;
      else {
        const prev = lastChar(line.slice(0, i));
        const next = firstChar(line.slice(i + 2));
        if ((next === "" || OPEN_NEXT.test(next)) && !WORD_BEFORE.test(prev))
          bold = i;
        // `2**31` or `src/**/*.ts`: this pair is not bold.
        else skip = true;
      }
      i += 2;
      continue;
    }
    i++;
  }
  let out = line;
  if (tick)
    out =
      tickAt + tick === line.length
        ? line.slice(0, tickAt)
        : line + "`".repeat(tick);
  if (bold >= 0) {
    // Nothing after the stars yet: hide them until the text arrives.
    if (bold + 2 >= out.trimEnd().length) return out.slice(0, bold);
    return out.trimEnd().replace(/(?<!\*)\*$/u, "") + "**";
  }
  if (!tick && /(?:^|[^*\\])\*$/u.test(out)) return out.slice(0, -1);
  return out;
}
