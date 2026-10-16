import {
  getOsc8LinkAtColumn,
  setCapabilityOverrides,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { Box, Text, renderToString } from "ink";
import { createElement } from "react";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mdToAnsi } from "./markdown.js";
import { visibleWidth } from "./wrap.js";
import { createTheme } from "../theme/tokens.js";

beforeEach(() => {
  setCapabilityOverrides({ hyperlinks: false });
});
afterEach(() => {
  setCapabilityOverrides({});
});

describe("terminal hyperlinks", () => {
  it.each([0, 3] as const)(
    "keeps links bounded after Ink reflows a stale wider row at color level %i",
    (level) => {
      setCapabilityOverrides({ hyperlinks: true });
      const previousLevel = chalk.level;
      chalk.level = level;
      try {
        const url = "https://example.com/docs";
        const lines = mdToAnsi(
          `[${"X".repeat(31)}](${url}) NORMAL_AFTER_ONE SECOND_AFTER_TWO`,
          { width: 80, theme: createTheme("dark", level) },
        );
        const output = renderToString(
          createElement(
            Box,
            { width: 12 },
            createElement(Text, null, lines.join("\n")),
          ),
          { columns: 12 },
        );
        let linkedCells = 0;
        for (const line of output.split("\n")) {
          const visible = stripVTControlCharacters(line);
          for (let column = 0; column <= visible.length; column++) {
            const expected = visible[column] === "X" ? url : undefined;
            expect(getOsc8LinkAtColumn(line, column)).toBe(expected);
            if (expected) linkedCells++;
          }
        }
        expect(linkedCells).toBe(31);
      } finally {
        chalk.level = previousLevel;
      }
    },
  );

  it.each([24, 40])(
    "keeps CJK and emoji hyperlink cells aligned at %i columns",
    (width) => {
      setCapabilityOverrides({ hyperlinks: true });
      const url = "https://example.com/docs";
      const label = "访问文档👩‍💻".repeat(5);
      const segments = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      const linkedGraphemes = new Set(
        Array.from(segments.segment(label), (item) => item.segment),
      );
      for (const source of [
        `BEFORE [${label}](${url}) AFTER`,
        `| Name | Link |\n| --- | --- |\n| test | [${label}](${url}) |`,
      ]) {
        let linkedCells = 0;
        for (const line of mdToAnsi(source, { width })) {
          let column = 0;
          for (const { segment } of segments.segment(
            stripVTControlCharacters(line),
          )) {
            const cells = visibleWidth(segment);
            const expected = linkedGraphemes.has(segment) ? url : undefined;
            for (let cell = 0; cell < cells; cell++) {
              expect(getOsc8LinkAtColumn(line, column++)).toBe(expected);
              if (expected) linkedCells++;
            }
          }
          expect(getOsc8LinkAtColumn(line, column)).toBeUndefined();
        }
        expect(linkedCells).toBe(visibleWidth(label));
      }
    },
  );

  it("closes each physical row when a link label contains an explicit newline", () => {
    setCapabilityOverrides({ hyperlinks: true });
    const lines = mdToAnsi("[multi\nline](https://example.com)\nplain", {
      width: 40,
    });
    expect(lines.map(stripVTControlCharacters)).toEqual([
      "multi",
      "line",
      "plain",
    ]);
    for (const line of lines.slice(0, 2)) {
      expect(line).toContain("\u001b]8;;https://example.com\u0007");
      expect(line.endsWith("\u001b]8;;\u0007")).toBe(true);
    }
    expect(lines[2]).not.toContain("\u001b]8;");
  });

  it.each([24, 40, 80])(
    "limits wrapped clickable ranges to link text at %i columns",
    (width) => {
      setCapabilityOverrides({ hyperlinks: true });
      const url = `https://example.com/${"long-path/".repeat(20)}`;
      const label = "X".repeat(73);
      for (const source of [
        `BEFORE [${label}](${url}) AFTER`,
        `| Name | Link |\n| --- | --- |\n| test | [${label}](${url}) |`,
      ]) {
        const lines = mdToAnsi(source, { width });
        let linkedCells = 0;
        for (const line of lines) {
          const visible = stripVTControlCharacters(line);
          for (let column = 0; column <= visible.length; column++) {
            const expected = visible[column] === "X" ? url : undefined;
            expect(getOsc8LinkAtColumn(line, column)).toBe(expected);
            if (expected) linkedCells++;
          }
        }
        expect(linkedCells).toBe(label.length);
      }
    },
  );

  it.each([8, 40, 80])(
    "preserves clickable labels and URLs at %i columns",
    (width) => {
      setCapabilityOverrides({ hyperlinks: true });
      const lines = mdToAnsi(
        "[documentation for this project](https://example.com/docs)\n\nhttps://example.org",
        { width },
      );
      const output = lines.join("\n");
      expect(output).toContain("\u001b]8;;https://example.com/docs\u0007");
      expect(output).toContain("\u001b]8;;https://example.org\u0007");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      for (const line of lines) {
        if (line.includes("\u001b]8;;https:")) {
          expect(line.lastIndexOf("\u001b]8;;\u0007")).toBeGreaterThan(
            line.lastIndexOf("\u001b]8;;https:"),
          );
        }
      }
    },
  );

  it("keeps table cells clickable without including borders", () => {
    setCapabilityOverrides({ hyperlinks: true });
    const lines = mdToAnsi(
      "| Name | Website |\n| --- | --- |\n| Example | [Visit](https://example.com) |",
      { width: 60 },
    );
    const row = lines.find((line) => line.includes("Visit"));
    expect(row).toContain(
      "\u001b]8;;https://example.com\u0007Visit\u001b]8;;\u0007",
    );
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("does not promote raw controls or non-web destinations to hyperlinks", () => {
    setCapabilityOverrides({ hyperlinks: true });
    const output = mdToAnsi(
      "\u001b]8;;https://injected.example\u001b\\raw\u001b]8;;\u001b\\\u001b]52;c;secret\u0007\n\n[local](file:///tmp/test) [bad](javascript:alert) [safe](https://example.com)",
      { width: 120 },
    ).join("\n");
    expect(output).not.toContain("injected.example");
    expect(output).not.toContain("\u001b]52");
    expect(output).not.toContain("\u001b]8;;file:");
    expect(output).not.toContain("\u001b]8;;javascript:");
    expect(stripVTControlCharacters(output)).toContain("local");
    expect(output).toContain("\u001b]8;;https://example.com\u0007");
  });
});

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
