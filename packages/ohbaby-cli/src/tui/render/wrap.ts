/* eslint-disable no-control-regex -- This display boundary deliberately recognizes and removes terminal control sequences. */
import {
  truncateToWidth,
  visibleWidth as piVisibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Raw input keeps SGR styles only. Rendered Markdown can additionally opt in
// to validated web links; cursor, title and clipboard controls remain forbidden.
const SGR = /(\u001b\[[0-9;:]*m)/gu;
const DISPLAY_CODES = /(\u001b\[[0-9;:]*m|\u001b\]8;;[^\u0007\u001b]*\u0007)/gu;
// Ink's fallback reflow recognizes BEL-terminated OSC 8 when closing and
// reopening links. Normalize Pi's ST terminators before reaching that layer.
const HYPERLINK_CLOSE = "\u001b]8;;\u0007";

function safeHyperlink(sequence: string): string {
  const match =
    /^\u001b\]8;;([^\u0000-\u0020\u007f-\u009f]*)(?:\u0007|\u001b\\)$/u.exec(
      sequence,
    );
  if (!match) return "";
  const url = match[1];
  if (url === "") return HYPERLINK_CLOSE;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname
      ? `\u001b]8;;${url}\u0007`
      : "";
  } catch {
    return "";
  }
}

export function sanitizeTerminalText(
  input: string,
  hyperlinks = false,
): string {
  return input
    .replace(/\r\n/gu, "\n")
    .replace(
      /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu,
      (sequence) => (hyperlinks ? safeHyperlink(sequence) : ""),
    )
    .replace(/\u001b[P_X^][\s\S]*?(?:\u001b\\|\u009c|$)/gu, "")
    .split(hyperlinks ? DISPLAY_CODES : SGR)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : stripVTControlCharacters(part).replace(
            /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu,
            "",
          ),
    )
    .join("");
}

export function visibleWidth(input: string): number {
  return piVisibleWidth(sanitizeTerminalText(input));
}

/** Display-only normalization; original input and tool facts remain untouched. */
function displayText(input: string, width: number, hyperlinks = false): string {
  let column = 0;
  return sanitizeTerminalText(input, hyperlinks)
    .split(hyperlinks ? DISPLAY_CODES : SGR)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let output = "";
      for (const { segment } of GRAPHEMES.segment(part)) {
        if (segment === "\n") {
          column = 0;
          output += segment;
        } else if (segment === "\t") {
          const spaces = 4 - (column % 4);
          output += " ".repeat(spaces);
          column += spaces;
        } else {
          const cells = piVisibleWidth(segment);
          // A two-cell grapheme cannot fit in a one-cell viewport. Keep it
          // intact in the source and show a single-cell placeholder here.
          output += cells > width ? "…" : segment;
          column += cells > width ? 1 : cells;
        }
      }
      return output;
    })
    .join("");
}

export function wrapAnsi(
  input: string,
  width: number,
  { hyperlinks = false }: { readonly hyperlinks?: boolean } = {},
): string[] {
  const columns = Math.max(1, Math.floor(width));
  return wrapTextWithAnsi(displayText(input, columns, hyperlinks), columns).map(
    (line) => {
      const styled = line.includes("\u001b[") ? `${line}\u001b[0m` : line;
      // Explicit newlines in Markdown labels can leave an open link on a row
      // that needs no further wrapping. Close it before viewport slicing or Ink.
      return line.lastIndexOf("\u001b]8;;") > line.lastIndexOf(HYPERLINK_CLOSE)
        ? `${styled}${HYPERLINK_CLOSE}`
        : styled;
    },
  );
}

export function truncateAnsi(input: string, width: number): string {
  const columns = Math.max(1, Math.floor(width));
  const source = displayText(input, columns);
  const result = truncateToWidth(
    source,
    columns,
    ".".repeat(Math.min(3, columns)),
  );
  return source.includes("\u001b[") ? result : stripVTControlCharacters(result);
}
