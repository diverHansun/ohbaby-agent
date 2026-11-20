import type { SessionSyncState } from "ohbaby-sdk";

export type SessionSyncBanner = "loading" | "recovering" | "error" | null;

/**
 * A baseline read for a newly selected session is ordinary loading, not
 * recovery. A retained view reconnects through the connection indicator; only
 * a failed attempt needs a recovery notice.
 */
export function isSessionRecovery(state: SessionSyncState): boolean {
  return (
    state.status === "syncing" &&
    (state.error !== undefined || state.attempts > 1)
  );
}

/**
 * Loading is reported at once so the screen never shows the new-chat greeting
 * for a session it is still reading; the placeholder itself waits in CSS, so a
 * fast read shows nothing.
 */
export function useSessionSyncBanner(
  state: SessionSyncState,
): SessionSyncBanner {
  if (state.status === "error") return "error";
  if (isSessionRecovery(state)) return "recovering";
  if (state.status === "syncing" && !state.view) return "loading";
  return null;
}
