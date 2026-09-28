import type { UiRun } from "./snapshot.js";

/** A newer Stop replaces this notice even when it has no unsent input. */
export function hasUnsentSteerAfterLatestStop(
  runs: readonly UiRun[],
  rootSessionId: string | null | undefined,
): boolean {
  const latest = runs
    .filter(
      (run) =>
        run.sessionId === rootSessionId &&
        run.inputsCloseReason === "user-stop",
    )
    .sort(
      (a, b) =>
        Date.parse(b.endedAt ?? b.updatedAt) -
          Date.parse(a.endedAt ?? a.updatedAt) || b.id.localeCompare(a.id),
    )
    .at(0);
  return latest?.unsentSteer === true;
}
