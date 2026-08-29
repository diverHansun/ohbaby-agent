import { describe, expect, it } from "vitest";
import { StartupNoticeBuffer } from "./startup-notice-buffer.js";

describe("StartupNoticeBuffer", () => {
  it("consumes notices exactly once and preserves their order", () => {
    const buffer = new StartupNoticeBuffer();
    buffer.push("first");
    buffer.push("second");

    expect(buffer.takeAll()).toEqual(["first", "second"]);
    expect(buffer.takeAll()).toEqual([]);
  });
});
