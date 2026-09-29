import type { SessionSyncState } from "ohbaby-sdk";
import { useEffect, useState } from "react";

/** A first read slower than this is worth telling the user about. */
export const INITIAL_LOAD_BANNER_DELAY_MS = 800;

export type SessionSyncBanner = "loading" | "recovering" | "error" | null;

/**
 * A baseline read for a newly selected session is ordinary loading, not
 * recovery. A retained view reconnects through the connection indicator; only
 * a failed attempt needs a recovery notice. Slow first reads use a placeholder.
 */
export function isSessionRecovery(state: SessionSyncState): boolean {
  return (
    state.status === "syncing" &&
    (state.error !== undefined || state.attempts > 1)
  );
}

export function useSessionSyncBanner(
  state: SessionSyncState,
): SessionSyncBanner {
  const initialLoad =
    state.status === "syncing" && !state.view && !isSessionRecovery(state);
  const scopeKey = state.scope
    ? `${state.scope.runtimeEpoch ?? ""}:${state.scope.sessionId}:${String(
        state.scope.bindingGeneration ?? "",
      )}`
    : "";
  const [slowScopeKey, setSlowScopeKey] = useState<string | null>(null);
  useEffect(() => {
    if (!initialLoad) return;
    const timer = setTimeout(() => {
      setSlowScopeKey(scopeKey);
    }, INITIAL_LOAD_BANNER_DELAY_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [initialLoad, scopeKey]);
  if (state.status === "error") return "error";
  if (isSessionRecovery(state)) return "recovering";
  if (initialLoad && slowScopeKey === scopeKey) return "loading";
  return null;
}
