export const STREAM_NEAR_BOTTOM_THRESHOLD_PX = 80;

export function isNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  threshold = STREAM_NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

export function scrollToBottom(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop">,
): void {
  if (element.scrollTop !== element.scrollHeight) {
    element.scrollTop = element.scrollHeight;
  }
}

/**
 * True when an upward wheel over `target` will scroll an inner region (tool
 * output, a long code block) rather than the stream itself.
 */
export function scrollsNested(
  target: EventTarget | null,
  stream: HTMLElement,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== stream) {
    if (node instanceof HTMLElement && node.scrollTop > 0) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    node = node.parentElement;
  }
  return false;
}
