const STORAGE_KEY = "ohbaby.web.sidebar.collapsed.v1";

/** Project groups the user collapsed, kept per browser; storage failures fall back to none. */
export function readCollapsedProjects(): ReadonlySet<string> {
  try {
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

export function writeCollapsedProjects(directories: ReadonlySet<string>): void {
  try {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...directories]),
    );
  } catch {
    // Collapse state is a convenience; it simply resets when storage is unavailable.
  }
}
