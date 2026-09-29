import type { KeyboardEvent } from "react";

export function isImeComposing(
  event: Pick<KeyboardEvent<HTMLElement>, "keyCode" | "nativeEvent">,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy browsers expose IME composition through keyCode 229.
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
