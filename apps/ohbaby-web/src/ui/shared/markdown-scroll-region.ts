/**
 * Wide diagrams and formulas scroll sideways inside their own box. While the
 * content is wider than the box, the box is a focusable named region so a
 * keyboard can scroll it, as wide tables are; when it fits, it is plain again.
 * One observer follows every box, so window resizes and a message folding
 * and unfolding keep the attributes in step with the real overflow.
 */
const labels = new WeakMap<Element, string>();
let observer: ResizeObserver | undefined;

function sync(element: HTMLElement): void {
  const label = labels.get(element);
  if (label === undefined) return;
  if (element.scrollWidth > element.clientWidth + 1) {
    element.tabIndex = 0;
    element.setAttribute("role", "region");
    element.setAttribute("aria-label", label);
  } else {
    element.removeAttribute("tabindex");
    element.removeAttribute("role");
    element.removeAttribute("aria-label");
  }
}

/** Follows `element`'s overflow until the returned function is called. */
export function trackScrollRegion(
  element: HTMLElement,
  label: string,
): () => void {
  labels.set(element, label);
  if (!observer && typeof ResizeObserver !== "undefined")
    observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        if (entry.target instanceof HTMLElement) sync(entry.target);
    });
  observer?.observe(element);
  sync(element);
  return () => {
    observer?.unobserve(element);
    labels.delete(element);
  };
}
