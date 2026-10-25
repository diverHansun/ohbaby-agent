/** Display name of a workspace: the last path segment. */
export function workspaceLabel(directory: string): string {
  const segments = directory.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? directory;
}

/** Shortens a macOS home path to `~/…` for compact display. */
export function compactHomePath(directory: string): string {
  const home = "/Users/";
  if (directory.startsWith(home)) {
    const parts = directory.slice(home.length).split("/");
    return parts.length > 1 ? `~/${parts.slice(1).join("/")}` : "~";
  }
  return directory;
}
