import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("assigns monotonic ids and preserves contiguous ranges", () => {
    const buffer = new RingBuffer<string>(3);

    expect(buffer.append("one")).toEqual({ id: 1, data: "one" });
    expect(buffer.append("two")).toEqual({ id: 2, data: "two" });
    expect(buffer.append("three")).toEqual({ id: 3, data: "three" });

    expect(buffer.oldestId).toBe(1);
    expect(buffer.latestId).toBe(3);
    expect(buffer.getRange(2, 3)).toEqual([
      { id: 2, data: "two" },
      { id: 3, data: "three" },
    ]);
    expect(buffer.isContinuous(0)).toBe(true);
    expect(buffer.isContinuous(2)).toBe(true);
  });

  it("overwrites the oldest entry when capacity is exceeded", () => {
    const buffer = new RingBuffer<string>(2);

    buffer.append("one");
    buffer.append("two");
    buffer.append("three");

    expect(buffer.oldestId).toBe(2);
    expect(buffer.latestId).toBe(3);
    expect(buffer.getRange(1, 3)).toEqual([
      { id: 2, data: "two" },
      { id: 3, data: "three" },
    ]);
    expect(buffer.isContinuous(0)).toBe(false);
    expect(buffer.isContinuous(1)).toBe(true);
  });
});
