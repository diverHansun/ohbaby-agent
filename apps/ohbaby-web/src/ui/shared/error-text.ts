// Browsers word a refused or dropped fetch differently.
const NETWORK_FAILURE =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/u;

// Protocol invariants the client checks; their wording is for developers.
const SYNC_FAILURE =
  /^(Permission subscription binding is missing or invalid|Daemon event is missing a valid sequence id|Daemon SSE payload must include a type)$/u;

/** Turns a raw error message into one a user can act on. */
export function readableError(message: string): string {
  if (NETWORK_FAILURE.test(message)) {
    return "Can't reach ohbaby. Check that it's still running.";
  }
  if (SYNC_FAILURE.test(message)) {
    globalThis.console.warn(`[ohbaby] ${message}`);
    return "Lost sync with ohbaby. Reload the page if this doesn't clear.";
  }
  return message;
}
