import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Visible, enabled elements Tab can reach inside `container`, in order. */
export function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => {
      if (element.closest("[hidden], [inert]")) return false;
      const visibility = getComputedStyle(element).visibility;
      if (visibility === "hidden" || visibility === "collapse") return false;
      // Responsive panes use CSS display:none, not the hidden attribute.
      for (
        let node: HTMLElement | null = element;
        node;
        node = node.parentElement
      )
        if (getComputedStyle(node).display === "none") return false;
      return true;
    },
  );
}

/** Keeps Tab and Shift+Tab cycling inside `container` (a modal dialog). */
export function trapTab(
  event: ReactKeyboardEvent,
  container: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !container) return;
  const items = focusableIn(container);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !container.contains(active))
  ) {
    event.preventDefault();
    first.focus();
  }
}
