import visibleWidth from "string-width";
import type { EditorState } from "./editor-reducer.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export interface EditorDisplayRow {
  readonly text: string;
  readonly hiddenBefore?: boolean;
  readonly resizeRequired?: boolean;
  readonly visibleRange?: { start: number; end: number; total: number };
  readonly cursorStart?: number;
  readonly cursorEnd?: number;
}

/** Display-only physical rows. The reducer remains the owner of the full draft. */
export function editorViewport(
  editor: EditorState,
  width: number,
  maxRows: number,
): readonly EditorDisplayRow[] {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return [{ text: "", resizeRequired: true }];
  const limit = Math.max(1, Math.floor(maxRows));
  const rows: EditorDisplayRow[] = [];
  for (const [lineIndex, line] of editor.lines.entries()) {
    const active = lineIndex === editor.cursor.row;
    const source =
      active && editor.cursor.col >= line.length ? `${line} ` : line;
    let current: EditorDisplayRow = { text: "" };
    let used = 0;
    let logicalColumn = 0;
    for (const { segment, index } of graphemes.segment(source)) {
      const display =
        segment === "\t" ? " ".repeat(4 - (logicalColumn % 4)) : segment;
      const size = visibleWidth(display);
      logicalColumn += size;
      if (segment !== "\t" && used > 0 && used + size > columns) {
        rows.push(current);
        current = { text: "" };
        used = 0;
      }
      if (segment === "\t") {
        for (let cell = 0; cell < size; cell += 1) {
          if (used === columns) {
            rows.push(current);
            current = { text: "" };
            used = 0;
          }
          const ownsCursor =
            active && editor.cursor.col === index && cell === 0;
          current = {
            ...current,
            ...(ownsCursor
              ? {
                  cursorStart: current.text.length,
                  cursorEnd: current.text.length + 1,
                }
              : {}),
            text: current.text + " ",
          };
          used += 1;
        }
        continue;
      }
      // A terminal narrower than one wide glyph still gets a bounded view.
      const text = size > columns ? "…" : segment;
      const ownsCursor =
        active &&
        editor.cursor.col >= index &&
        editor.cursor.col < index + segment.length;
      current = {
        ...current,
        ...(size > columns ? { resizeRequired: true } : {}),
        ...(ownsCursor
          ? {
              cursorStart: current.text.length,
              cursorEnd: current.text.length + text.length,
            }
          : {}),
        text: current.text + text,
      };
      used += Math.min(size, columns);
    }
    rows.push(current);
  }
  const cursorRow = Math.max(
    0,
    rows.findIndex((row) => row.cursorStart !== undefined),
  );
  const start = Math.max(
    0,
    Math.min(cursorRow - limit + 1, rows.length - limit),
  );
  return rows.slice(start, start + limit).map((row, index) =>
    index === 0 && rows.length > limit
      ? {
          ...row,
          ...(start > 0 ? { hiddenBefore: true } : {}),
          visibleRange: {
            start: start + 1,
            end: Math.min(start + limit, rows.length),
            total: rows.length,
          },
        }
      : row,
  );
}
