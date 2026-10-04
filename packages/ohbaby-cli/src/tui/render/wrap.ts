/* eslint-disable no-control-regex -- This display boundary deliberately recognizes and removes terminal control sequences. */
import {
  truncateToWidth,
  visibleWidth as piVisibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Preserve SGR styles only. Output must never move the cursor, set a title,
// change the clipboard, or invoke a terminal protocol on behalf of a tool.
const SGR = /(\u001b\[[0-9;:]*m)/gu;

export function sanitizeTerminalText(input: string): string {
  return input
    .replace(/\r\n/gu, "\n")
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "")
    .replace(/\u001b[P_X^][\s\S]*?(?:\u001b\\|\u009c|$)/gu, "")
    .split(SGR)
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
function displayText(input: string, width: number): string {
  let column = 0;
  return sanitizeTerminalText(input)
    .split(SGR)
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

export function wrapAnsi(input: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  return wrapTextWithAnsi(displayText(input, columns), columns).map((line) =>
    line.includes("\u001b[") ? `${line}\u001b[0m` : line,
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
