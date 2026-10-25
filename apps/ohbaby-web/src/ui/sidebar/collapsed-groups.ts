const STORAGE_KEY = "ohbaby.web.sidebar.collapsed.v2";
/** v1 stored `project:` keys; its values are dropped rather than converted. */
const LEGACY_STORAGE_KEY = "ohbaby.web.sidebar.collapsed.v1";

/** Groups the user collapsed (Pinned, workspaces), kept per browser; storage failures fall back to none. */
export function readCollapsedGroups(): ReadonlySet<string> {
  try {
    globalThis.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(keys: ReadonlySet<string>): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Collapse state is a convenience; it simply resets when storage is unavailable.
  }
}
