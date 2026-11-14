/**
 * How long Cancel (background tasks) and Stop (subagents) wait for an answer
 * before giving the button back. The backend answers within about two
 * seconds (a task stop in about 1.2 s, a subagent stop after at most a 2 s
 * cleanup wait), so this only runs out when the request is lost or the
 * services hang.
 */
export const STOP_REQUEST_TIMEOUT_MS = 10_000;

/** Whether a request ended because its `AbortSignal.timeout` ran out. */
export function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}
