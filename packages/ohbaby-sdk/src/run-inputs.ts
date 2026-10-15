import type { UiSession, UiUnconsumedSteer } from "./snapshot.js";

/** Recovery is session-wide and independent of the currently loaded chat page. */
export function getUnconsumedSteers(
  session: UiSession | null | undefined,
): readonly UiUnconsumedSteer[] {
  return session?.unconsumedSteers ?? [];
}
