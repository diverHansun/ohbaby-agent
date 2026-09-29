import { describe, expect, it } from "vitest";
import {
  isNearBottom,
  scrollToBottom,
  STREAM_NEAR_BOTTOM_THRESHOLD_PX,
} from "./streamScroll.js";

describe("stream scroll helpers", () => {
  it("treats the configured threshold as the bottom boundary", () => {
    expect(
      isNearBottom({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 520,
      }),
    ).toBe(true);
    expect(
      isNearBottom({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 519,
      }),
    ).toBe(false);
    expect(STREAM_NEAR_BOTTOM_THRESHOLD_PX).toBe(80);
  });

  it("scrolls only when the element is not already at the bottom", () => {
    const element = { scrollHeight: 1_000, scrollTop: 400 };
    scrollToBottom(element);
    expect(element.scrollTop).toBe(1_000);

    scrollToBottom(element);
    expect(element.scrollTop).toBe(1_000);
  });
});
