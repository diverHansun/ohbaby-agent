export interface TuiLayoutMetrics {
  readonly columns: number;
  readonly rows: number;
  readonly contentWidth: number;
  readonly horizontalPadding: number;
  readonly isCompact: boolean;
  readonly liveTailRows: number;
}

const MAX_CONTENT_WIDTH = 220;
// Rows kept free for the prompt, spinner, notices, and margins so the dynamic
// (non-Static) frame never reaches the terminal height. Ink falls back to a
// clearTerminal-per-frame strategy once the frame is as tall as the terminal,
// which wipes the scrollback buffer and flickers on every render.
const LIVE_TAIL_RESERVED_ROWS = 10;
const MIN_LIVE_TAIL_ROWS = 3;

export function computeLayoutMetrics(input: {
  readonly columns: number;
  readonly rows: number;
}): TuiLayoutMetrics {
  // Non-TTY streams (tests, pipes) report no dimensions; fall back to a
  // conventional 80x24 terminal instead of letting NaN poison the layout.
  const columns = Math.max(
    1,
    Math.floor(Number.isFinite(input.columns) ? input.columns : 80),
  );
  const rows = Math.max(
    1,
    Math.floor(Number.isFinite(input.rows) ? input.rows : 24),
  );
  const isCompact = columns < 80;
  const horizontalPadding = isCompact ? 2 : 4;
  const contentWidth = Math.min(
    MAX_CONTENT_WIDTH,
    Math.max(24, columns - horizontalPadding * 2),
  );

  const liveTailRows = Math.max(
    MIN_LIVE_TAIL_ROWS,
    rows - LIVE_TAIL_RESERVED_ROWS,
  );

  return {
    columns,
    contentWidth,
    horizontalPadding,
    isCompact,
    liveTailRows,
    rows,
  };
}
