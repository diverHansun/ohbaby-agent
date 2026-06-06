import { describe, expect, it } from "vitest";
import { mdToAnsi } from "./markdown.js";
import { visibleWidth } from "./wrap.js";

describe("mdToAnsi", () => {
  it("renders core markdown blocks into terminal-ready lines", () => {
    const lines = mdToAnsi(
      "# Title\n\n- first **item**\n> quoted\n\n```ts\nconst x = 1;\n```",
      { width: 80 },
    );

    expect(lines).toEqual([
      "Title",
      "-----",
      "",
      "- first item",
      "> quoted",
      "",
      "```ts",
      "  const x = 1;",
      "```",
    ]);
  });

  it("wraps output lines to the supplied visible width", () => {
    const lines = mdToAnsi("A very long assistant sentence for wrapping.", {
      width: 12,
    });

    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(lines).toEqual([
      "A very long",
      "assistant",
      "sentence for",
      "wrapping.",
    ]);
  });
});
