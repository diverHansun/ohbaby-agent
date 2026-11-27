import type { TuiCommandCatalog } from "../../store/snapshot.js";
import type { EditorDisplayRow } from "./editor-viewport.js";

/**
 * How many characters of the first logical line are a known skill's `/name`,
 * or 0 (skill UX T2). Names compare case-insensitively, as the backend
 * resolves them; built-in commands run on Enter and are never colored.
 */
export function skillNameEnd(
  firstLine: string,
  catalog: TuiCommandCatalog | null,
): number {
  const head = /^\/(\S+)/u.exec(firstLine);
  if (!head || !catalog) return 0;
  const name = head[1].toLowerCase();
  const known = catalog.commands.some(
    (command) =>
      command.source === "skill" &&
      command.path.length === 1 &&
      command.path[0]?.toLowerCase() === name,
  );
  return known ? head[0].length : 0;
}

export interface RowPiece {
  readonly text: string;
  readonly cursor: boolean;
  readonly skill: boolean;
}

/**
 * Cuts one display row at the cursor and at the end of the skill name. Only
 * rows of the first logical line can hold the name; a row that starts past
 * it, or any other line, is never colored.
 */
export function rowPieces(
  row: EditorDisplayRow,
  skillEnd: number,
  showCursor: boolean,
): readonly RowPiece[] {
  const nameEnd =
    row.line === 0 ? Math.min(row.text.length, Math.max(0, skillEnd - row.offset)) : 0;
  const cursorStart = showCursor ? row.cursorStart : undefined;
  const cursorEnd = cursorStart === undefined ? undefined : row.cursorEnd;
  const cuts = [
    ...new Set(
      [0, nameEnd, cursorStart, cursorEnd, row.text.length].filter(
        (cut): cut is number => cut !== undefined,
      ),
    ),
  ].sort((a, b) => a - b);
  const pieces: RowPiece[] = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const start = cuts[index] ?? 0;
    const end = cuts[index + 1] ?? start;
    if (end <= start) continue;
    pieces.push({
      text: row.text.slice(start, end),
      cursor:
        cursorStart !== undefined &&
        cursorEnd !== undefined &&
        start >= cursorStart &&
        end <= cursorEnd,
      skill: end <= nameEnd,
    });
  }
  return pieces;
}
