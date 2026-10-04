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
      "",
      "- first item",
      "│ quoted",
      "",
      "```ts",
      "  const x = 1;",
      "```",
    ]);
  });

  it.each([
    {
      name: "emphasis spanning a soft line break",
      source: "*first\nsecond*\n",
      expected: ["first", "second"],
    },
    {
      name: "inline links spanning a soft line break",
      source: "[multi\nline](https://example.com)\n",
      expected: ["multi", "line (https://example.com)"],
    },
    {
      name: "reference links whose definition is in a later block",
      source: "[read docs][ref]\n\n[ref]: https://example.com/docs",
      expected: ["read docs (https://example.com/docs)", ""],
    },
  ])("preserves whole-document semantics for $name", ({ source, expected }) => {
    expect(mdToAnsi(source, { width: 80 })).toEqual(expected);
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

describe("Pi Markdown display boundary", () => {
  it("keeps inline code distinguishable without color", () => {
    expect(mdToAnsi("Run `pnpm test` now.", { width: 80 }).join("\n")).toBe(
      "Run `pnpm test` now.",
    );
  });
  it.each([1, 8, 24, 58, 78, 118])(
    "keeps tables, code and links within %i columns",
    (width) => {
      const source =
        "## 中文 👨‍👩‍👧‍👦\n\n| 名称 | Value |\n| --- | --- |\n| 中文 | `alpha_beta` |\n\n1. first\n   - nested\n\n[docs](https://example.com/long/path)\n\n```ts\n\tconst 中文 = '👩‍💻';\n  final line";
      const lines = mdToAnsi(source, { width });
      expect(lines.length).toBeGreaterThan(5);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 24) {
        expect(lines.join("\n")).toContain("alpha_beta");
        expect(lines.join("\n")).toContain("example.com");
        expect(lines.join("\n")).toContain("final line");
      }
      expect(lines.join("\n")).not.toContain("\u001b]");
    },
  );
  it("handles streaming incomplete structures without dropping text or executing controls", () => {
    for (const source of [
      "**unfinished",
      "```ts\nconst x = 1;",
      "safe\u001b[2J\u001b]52;c;abc\u0007text",
    ]) {
      const output = mdToAnsi(source, { width: 40 }).join("\n");
      expect(output).not.toContain("\u001b[2J");
      expect(output).not.toContain("\u001b]");
      expect(output).toMatch(/unfinished|const x = 1;|safetext/u);
    }
  });
});
