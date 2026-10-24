import { SESSION_MOVED_ERROR_CODE } from "ohbaby-sdk";
import { isDaemonRequestError } from "../api/daemon/http.js";
import type { OhbabyWebStore } from "../store/store.js";

/** How long a resend waits for the moved session to synchronize. */
const READY_TIMEOUT_MS = 10_000;

/** The directory a rejected request must move to, if it was `SESSION_MOVED`. */
export function sessionMovedTarget(error: unknown): string | undefined {
  return isDaemonRequestError(error) &&
    error.code === SESSION_MOVED_ERROR_CODE &&
    typeof error.targetDirectory === "string" &&
    error.targetDirectory.length > 0
    ? error.targetDirectory
    : undefined;
}

/**
 * Resolves once `sessionId` is bound and its view is synchronized, so a
 * resend passes the client's readiness check. Rejects on timeout or when
 * another session is bound first.
 */
export function waitForSessionReady(
  store: OhbabyWebStore,
  sessionId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const snapshot = store.getSnapshot();
      const bound = snapshot.permissionSync.binding?.rootSessionId;
      if (bound === sessionId && snapshot.sessionSync.status === "ready") {
        finish();
        resolve();
        return true;
      }
      if (bound !== undefined && bound !== null && bound !== sessionId) {
        finish();
        reject(new Error("Another session was opened before the resend"));
        return true;
      }
      return false;
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("The moved session did not synchronize in time"));
    }, READY_TIMEOUT_MS);
    const unsubscribe = store.subscribe(() => {
      check();
    });
    function finish(): void {
      clearTimeout(timer);
      unsubscribe();
    }
    check();
  });
}
