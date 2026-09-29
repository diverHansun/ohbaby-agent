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
