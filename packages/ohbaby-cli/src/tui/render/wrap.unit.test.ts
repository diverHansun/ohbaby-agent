import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
  sanitizeTerminalText,
  truncateAnsi,
  visibleWidth,
  wrapAnsi,
} from "./wrap.js";

describe("ANSI width rendering helpers", () => {
  it.each([
    ["❤️", 2],
    ["❤", 1],
    ["👩‍💻", 2],
    ["👨‍👩‍👧‍👦", 2],
    ["🇹🇼", 2],
    ["👍🏽", 2],
    ["1️⃣", 2],
    ["é", 1],
    ["中文", 4],
  ])("measures grapheme %s as %i terminal columns", (text, width) => {
    expect(visibleWidth(text)).toBe(width);
  });
  it("keeps graphemes intact and closes styles on every wrapped row", () => {
    const lines = wrapAnsi("\u001b[32m❤️👩‍💻❤️\u001b[0m", 2);
    expect(lines.map(stripVTControlCharacters)).toEqual(["❤️", "👩‍💻", "❤️"]);
    expect(
      lines.every(
        (line) => line.startsWith("\u001b[32m") && line.endsWith("\u001b[0m"),
      ),
    ).toBe(true);
    expect(truncateAnsi("❤️👩‍💻abcdef", 7)).toBe("❤️👩‍💻...");
    expect(wrapAnsi("中👩‍💻é", 1)).toEqual(["…", "…", "é"]);
  });
  it("wraps styled words to the same width as plain words", () => {
    const wrapped = wrapAnsi("aa \u001b[32mbbbb\u001b[0m cc", 6);
    expect(wrapped.map(stripVTControlCharacters)).toEqual(
      wrapAnsi("aa bbbb cc", 6),
    );
    expect(wrapped.every((line) => visibleWidth(line) <= 6)).toBe(true);
  });
  it("truncates by visible width and closes its style", () => {
    const result = truncateAnsi("\u001b[36mabcdef\u001b[0m", 5);
    expect(stripVTControlCharacters(result)).toBe("ab...");
    expect(result).toContain("\u001b[36m");
    expect(result.endsWith("\u001b[0m")).toBe(true);
  });
  it("removes terminal commands but preserves text and safe styles", () => {
    const source =
      "\u001b[2J\u001b[10A\u001b]52;c;c2VjcmV0\u0007\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\\u001b[31mred\u001b[0m\r\n\tend";
    const safe = sanitizeTerminalText(source);
    expect(safe).toBe("link\u001b[31mred\u001b[0m\n\tend");
    expect(wrapAnsi(source, 80).map(stripVTControlCharacters)).toEqual([
      "linkred",
      "    end",
    ]);
  });
  it("preserves code indentation and tab stops in display rows", () => {
    expect(wrapAnsi("  a  b\n中\tx", 20)).toEqual(["  a  b", "中  x"]);
  });
});
