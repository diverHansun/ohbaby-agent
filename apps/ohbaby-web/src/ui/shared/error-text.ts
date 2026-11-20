import { isDaemonRequestError } from "../../api/daemon/http.js";

// Browsers word a refused or dropped fetch differently.
const NETWORK_FAILURE =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/u;

// Protocol invariants the client checks; their wording is for developers.
const SYNC_FAILURE =
  /^(Permission subscription binding is missing or invalid|Daemon event is missing a valid sequence id|Daemon SSE payload must include a type)$/u;

// The server could not use the folder a request was scoped to.
const MISSING_FOLDER_CODES: ReadonlySet<string> = new Set([
  "directory-unavailable",
  "directory-not-directory",
]);

/** Turns a raw error message into one a user can act on. */
export function readableError(message: string): string {
  if (NETWORK_FAILURE.test(message)) {
    return "Can't reach your services. Check that they're still running.";
  }
  if (SYNC_FAILURE.test(message)) {
    globalThis.console.warn(`[ohbaby] ${message}`);
    return "Lost sync with your services. Reload the page if this doesn't clear.";
  }
  return message;
}

/** A chat whose folder is gone opens again after Move to workspace. */
export function sessionOpenError(error: unknown): string {
  if (
    isDaemonRequestError(error) &&
    error.code !== undefined &&
    MISSING_FOLDER_CODES.has(error.code)
  ) {
    return "This chat's folder is missing or unreadable. Use Move to workspace in the chat menu to choose an available folder.";
  }
  return error instanceof Error ? error.message : String(error);
}
