const STORAGE_KEY = "ohbaby.web.navigation.v1";

export interface WebNavigationState {
  readonly selectedDirectory: string | null;
  readonly sessionByDirectory: Readonly<Record<string, string>>;
}

const EMPTY_STATE: WebNavigationState = {
  selectedDirectory: null,
  sessionByDirectory: {},
};

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
  const value = storage()?.getItem(STORAGE_KEY);
  if (!value) {
    return EMPTY_STATE;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_STATE;
    }
    const selectedDirectory =
      "selectedDirectory" in parsed &&
      typeof parsed.selectedDirectory === "string"
        ? parsed.selectedDirectory
        : null;
    const rawSessions =
      "sessionByDirectory" in parsed &&
      typeof parsed.sessionByDirectory === "object" &&
      parsed.sessionByDirectory !== null
        ? parsed.sessionByDirectory
        : {};
    const sessionByDirectory = Object.fromEntries(
      Object.entries(rawSessions).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return { selectedDirectory, sessionByDirectory };
  } catch {
    return EMPTY_STATE;
  }
}

export function writeWebNavigationState(state: WebNavigationState): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
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
