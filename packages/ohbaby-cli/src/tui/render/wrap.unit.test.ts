import { describe, expect, it } from "vitest";
import { truncateAnsi, visibleWidth, wrapAnsi } from "./wrap.js";

describe("ANSI width rendering helpers", () => {
  it("measures visible width without counting ANSI escape sequences", () => {
    expect(visibleWidth("\u001B[31mred\u001B[0m")).toBe(3);
  });

  it("wraps ANSI strings without splitting escape sequences", () => {
    const wrapped = wrapAnsi("aa \u001B[32mbbbb\u001B[0m cc", 6);

    expect(wrapped).toEqual(["aa \u001B[32mbbb", "b\u001B[0m cc"]);
    expect(wrapped.every((line) => visibleWidth(line) <= 6)).toBe(true);
    expect(wrapped.join("")).toBe("aa \u001B[32mbbbb\u001B[0m cc");
  });

  it("truncates by visible width while preserving complete ANSI sequences", () => {
    expect(truncateAnsi("\u001B[36mabcdef\u001B[0m", 5)).toBe(
      "\u001B[36mab...\u001B[0m",
    );
  });
});
