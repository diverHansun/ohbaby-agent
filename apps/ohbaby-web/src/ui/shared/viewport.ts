// Breakpoints from 03 §3.4: phones below 640px, narrow desktops below 1024px.
const NARROW_QUERY = "(max-width: 1023px)";
const PHONE_QUERY = "(max-width: 639px)";

function matches(query: string): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

/** Below 1024px the sidebar is a drawer over the main area. */
export function isNarrowViewport(): boolean {
  return matches(NARROW_QUERY);
}

/** Below 640px menus open as bottom sheets. */
export function isPhoneViewport(): boolean {
  return matches(PHONE_QUERY);
}
