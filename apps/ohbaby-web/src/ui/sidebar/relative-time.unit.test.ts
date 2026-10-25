import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time.js";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const ago = (ms: number): string => new Date(now - ms).toISOString();

describe("relative time", () => {
  it.each([
    [ago(10_000), "now"],
    [ago(5 * 60_000), "5m"],
    [ago(3 * 3_600_000), "3h"],
    [ago(2 * 86_400_000), "2d"],
    [ago(15 * 86_400_000), "2w"],
    [ago(100 * 86_400_000), "3mo"],
    [ago(800 * 86_400_000), "2y"],
    [new Date(now + 60_000).toISOString(), "now"],
    ["not a date", ""],
  ])("formats %s as %s", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});
