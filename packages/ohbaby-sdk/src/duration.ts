/** Whole seconds for display; stored observations retain millisecond precision. */
export function formatDurationSeconds(value: number): string {
  let seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const units = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const;
  const parts: string[] = [];
  for (const [size, suffix] of units) {
    const count = Math.floor(seconds / size);
    seconds %= size;
    if (count > 0 || parts.length > 0 || size === 1)
      parts.push(`${String(count)}${suffix}`);
  }
  return parts.join(" ");
}
export interface DurationAnchor {
  readonly elapsedMs: number;
  readonly monotonicAt: number;
  readonly terminal: boolean;
  /** Consumers can report this diagnostic without exposing client wall-clock skew. */
  readonly clockAnomaly: boolean;
}
export function createDurationAnchor(input: {
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly serverNow?: number;
  readonly monotonicNow: number;
}): DurationAnchor | undefined {
  const end = input.endedAt ?? input.serverNow;
  if (
    end === undefined ||
    !Number.isFinite(end) ||
    !Number.isFinite(input.startedAt)
  )
    return undefined;
  return {
    elapsedMs: Math.max(0, end - input.startedAt),
    monotonicAt: input.monotonicNow,
    terminal: input.endedAt !== undefined,
    clockAnomaly: end < input.startedAt,
  };
}
export function elapsedDurationMs(
  anchor: DurationAnchor | undefined,
  monotonicNow: number,
): number | undefined {
  if (!anchor) return undefined;
  return (
    anchor.elapsedMs +
    (anchor.terminal ? 0 : Math.max(0, monotonicNow - anchor.monotonicAt))
  );
}
