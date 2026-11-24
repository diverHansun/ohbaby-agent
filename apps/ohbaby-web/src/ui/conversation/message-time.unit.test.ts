import { describe, expect, it } from "vitest";
import { formatFullMessageTime, formatMessageTime } from "./message-time.js";

// Local times throughout: the repo pins no TZ, and the output is local.
const at = (
  ...parts: [number, number, number, number, number, number?]
): string => new Date(...parts).toISOString();
const now = new Date(2026, 10, 24, 15, 0).getTime();

describe("formatMessageTime (message time 04 F)", () => {
  it.each([
    ["F-1 today", at(2026, 10, 24, 14, 32), "14:32"],
    ["F-2 just after midnight", at(2026, 10, 24, 0, 5), "00:05"],
    ["F-3 yesterday", at(2026, 10, 23, 23, 59), "11-23 23:59"],
    ["F-4 earlier this year", at(2026, 0, 2, 9, 7), "01-02 09:07"],
    ["F-5 same day last year", at(2025, 10, 24, 14, 32), "2025-11-24 14:32"],
    ["F-6 last year's end", at(2025, 11, 31, 23, 59), "2025-12-31 23:59"],
    ["F-9 seconds don't round up", at(2026, 10, 24, 14, 32, 59), "14:32"],
  ])("%s", (_name, iso, expected) => {
    expect(formatMessageTime(iso, now)).toBe(expected);
  });

  it("F-7 returns nothing for an invalid time", () => {
    expect(formatMessageTime("not a time", now)).toBe("");
    expect(formatFullMessageTime("not a time")).toBe("");
  });

  it("F-8 writes the tooltip in full", () => {
    expect(formatFullMessageTime(at(2026, 10, 24, 14, 32))).toBe(
      "2026-11-24 14:32",
    );
  });
});
