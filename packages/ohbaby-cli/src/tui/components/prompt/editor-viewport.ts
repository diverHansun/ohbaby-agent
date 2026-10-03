import { visibleWidth } from "../../render/wrap.js";
import type { EditorState } from "./editor-reducer.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export interface EditorDisplayRow {
  readonly text: string;
  readonly hiddenBefore?: boolean;
  readonly cursorStart?: number;
  readonly cursorEnd?: number;
}

/** Display-only physical rows. The reducer remains the owner of the full draft. */
export function editorViewport(
  editor: EditorState,
  width: number,
  maxRows: number,
): readonly EditorDisplayRow[] {
  const columns = Math.max(1, Math.floor(width));
  const limit = Math.max(1, Math.floor(maxRows));
  const rows: EditorDisplayRow[] = [];
  for (const [lineIndex, line] of editor.lines.entries()) {
    const active = lineIndex === editor.cursor.row;
    const source =
      active && editor.cursor.col >= line.length ? `${line} ` : line;
    let current: EditorDisplayRow = { text: "" };
    let used = 0;
    for (const { segment, index } of graphemes.segment(source)) {
      const size = visibleWidth(segment);
      if (used > 0 && used + size > columns) {
        rows.push(current);
        current = { text: "" };
        used = 0;
      }
      // A terminal narrower than one wide glyph still gets a bounded view.
      const text = size > columns ? "…" : segment;
      const ownsCursor =
        active &&
        editor.cursor.col >= index &&
        editor.cursor.col < index + segment.length;
      current = {
        ...current,
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
  return rows
    .slice(start, start + limit)
    .map((row, index) =>
      index === 0 && start > 0 ? { ...row, hiddenBefore: true } : row,
    );
}
