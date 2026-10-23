const STORAGE_KEY = "ohbaby.web.sidebar.open.v1";
const NARROW_QUERY = "(max-width: 1023px)";

/** Narrow windows start with the sidebar closed; wide windows remember the last choice. */
export function initialSidebarOpen(): boolean {
  if (isNarrowViewport()) return false;
  try {
    return globalThis.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function rememberSidebarOpen(open: boolean): void {
  if (isNarrowViewport()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
    // Remembering the sidebar is a convenience only.
  }
}

export function isNarrowViewport(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}
