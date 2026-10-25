const STORAGE_KEY = "ohbaby.web.navigation.v2";
const LEGACY_STORAGE_KEY = "ohbaby.web.navigation.v1";

/** The session to reopen on a plain reload; null means a new-chat draft. */
export interface WebNavigationState {
  readonly lastSession: {
    readonly sessionId: string;
    /** Request directory when the session was last open. */
    readonly directory: string;
  } | null;
}

const EMPTY_STATE: WebNavigationState = { lastSession: null };

function storage(): Storage | undefined {
  try {
    const candidate: unknown = globalThis.localStorage;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("getItem" in candidate) ||
      !("setItem" in candidate) ||
      typeof candidate.getItem !== "function" ||
      typeof candidate.setItem !== "function"
    ) {
      return undefined;
    }
    return candidate as Storage;
  } catch {
    return undefined;
  }
}

export function readWebNavigationState(): WebNavigationState {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    if (value) return parseState(JSON.parse(value));
    const legacy = storage()?.getItem(LEGACY_STORAGE_KEY);
    return legacy ? parseLegacyState(JSON.parse(legacy)) : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function parseState(value: unknown): WebNavigationState {
  if (typeof value !== "object" || value === null || !("lastSession" in value))
    return EMPTY_STATE;
  const last: unknown = value.lastSession;
  return typeof last === "object" &&
    last !== null &&
    "sessionId" in last &&
    "directory" in last &&
    typeof last.sessionId === "string" &&
    typeof last.directory === "string"
    ? { lastSession: { sessionId: last.sessionId, directory: last.directory } }
    : EMPTY_STATE;
}

/** v1 kept a selected directory and its last session; that pair still reopens. */
function parseLegacyState(value: unknown): WebNavigationState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("selectedDirectory" in value) ||
    typeof value.selectedDirectory !== "string" ||
    !("sessionByDirectory" in value) ||
    typeof value.sessionByDirectory !== "object" ||
    value.sessionByDirectory === null
  )
    return EMPTY_STATE;
  const directory = value.selectedDirectory;
  const sessionId: unknown = (
    value.sessionByDirectory as Record<string, unknown>
  )[directory];
  return typeof sessionId === "string"
    ? { lastSession: { sessionId, directory } }
    : EMPTY_STATE;
}

export function writeWebNavigationState(state: WebNavigationState): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Navigation memory is a convenience; denial only loses the reload target.
  }
}

export function replaceNavigationHash(input: {
  readonly directory: string | null;
  readonly sessionId?: string | null;
}): void {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams();
  if (input.directory) {
    params.set("directory", input.directory);
  }
  if (input.sessionId) {
    params.set("session", input.sessionId);
  }
  const hash = params.toString();
  const next = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`;
  window.history.replaceState(window.history.state, "", next);
}
