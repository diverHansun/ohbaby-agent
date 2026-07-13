import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime.js";

describe("isImeComposing", () => {
  it("recognizes the standard composing flag", () => {
    expect(isImeComposing(keyboardEvent(true, 13))).toBe(true);
    expect(isImeComposing(keyboardEvent(false, 13))).toBe(false);
  });

  it("recognizes the legacy 229 key code fallback", () => {
    expect(isImeComposing(keyboardEvent(false, 229))).toBe(true);
  });
});

function keyboardEvent(
  isComposing: boolean,
  keyCode: number,
): Pick<KeyboardEvent<HTMLElement>, "keyCode" | "nativeEvent"> {
  return {
    keyCode,
    nativeEvent: { isComposing } as KeyboardEvent<HTMLElement>["nativeEvent"],
  };
}
