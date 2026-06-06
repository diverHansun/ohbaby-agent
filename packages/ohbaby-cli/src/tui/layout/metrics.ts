export interface TuiLayoutMetrics {
  readonly columns: number;
  readonly rows: number;
  readonly contentWidth: number;
  readonly horizontalPadding: number;
  readonly isCompact: boolean;
}

export function computeLayoutMetrics(input: {
  readonly columns: number;
  readonly rows: number;
}): TuiLayoutMetrics {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const isCompact = columns < 80;
  const horizontalPadding = isCompact ? 2 : 4;
  const contentWidth = Math.min(
    132,
    Math.max(24, columns - horizontalPadding * 2),
  );

  return {
    columns,
    contentWidth,
    horizontalPadding,
    isCompact,
    rows,
  };
}
