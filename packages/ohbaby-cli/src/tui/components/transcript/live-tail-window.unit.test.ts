import { describe, expect, it } from "vitest";
import { clampRenderedPartsToTail } from "./live-tail-window.js";
import type { RenderedPart } from "../message/message-row.js";

describe("clampRenderedPartsToTail", () => {
  it("returns all parts untouched when they fit within the budget", () => {
    const parts = [textPart(0, lines(3)), spinnerPart(1)];

    const window = clampRenderedPartsToTail(parts, 10);

    expect(window.parts).toEqual(parts);
    expect(window.hiddenLineCount).toBe(0);
  });

  it("keeps only the trailing lines of an oversized text part", () => {
    const parts = [textPart(0, lines(20))];

    const window = clampRenderedPartsToTail(parts, 6);

    expect(window.hiddenLineCount).toBe(15);
    expect(window.parts).toHaveLength(1);
    const clamped = window.parts[0];
    expect(clamped.kind).toBe("text");
    if (clamped.kind === "text") {
      expect(clamped.text.split("\n")).toEqual([
        "line 15",
        "line 16",
        "line 17",
        "line 18",
        "line 19",
      ]);
    }
  });

  it("drops whole leading parts before slicing the boundary part", () => {
    const parts = [textPart(0, lines(10)), textPart(1, lines(4))];

    const window = clampRenderedPartsToTail(parts, 4);

    expect(window.hiddenLineCount).toBe(11);
    expect(window.parts).toHaveLength(1);
    const clamped = window.parts[0];
    if (clamped.kind === "text") {
      expect(clamped.index).toBe(1);
      expect(clamped.text.split("\n")).toEqual(["line 1", "line 2", "line 3"]);
    }
  });

  it("keeps a trailing spinner part visible", () => {
    const parts = [textPart(0, lines(30)), spinnerPart(1)];

    const window = clampRenderedPartsToTail(parts, 5);

    expect(window.parts.at(-1)?.kind).toBe("spinner");
    expect(window.hiddenLineCount).toBe(27);
    const total = countLines(window.parts);
    expect(total).toBeLessThanOrEqual(4);
  });

  it("drops a segmented boundary part instead of slicing it mid-segment", () => {
    const parts = [segmentedTextPart(0, lines(3)), textPart(1, lines(2))];

    const window = clampRenderedPartsToTail(parts, 3);

    expect(window.parts).toHaveLength(1);
    const clamped = window.parts[0];
    if (clamped.kind === "text") {
      expect(clamped.index).toBe(1);
    }
    expect(window.hiddenLineCount).toBe(3);
  });

  it("keeps visible plain-text tail lines for an oversized segmented part", () => {
    const parts = [segmentedTextPart(0, lines(5))];

    const window = clampRenderedPartsToTail(parts, 3);

    expect(window.hiddenLineCount).toBe(3);
    expect(window.parts).toHaveLength(1);
    const clamped = window.parts[0];
    expect(clamped.kind).toBe("text");
    if (clamped.kind === "text") {
      expect(clamped.text.split("\n")).toEqual(["line 3", "line 4"]);
      expect(clamped.segments).toBeUndefined();
    }
  });

  it("preserves the full parts array identity when nothing is hidden", () => {
    const parts = [textPart(0, lines(2))];

    const window = clampRenderedPartsToTail(parts, 2);

    expect(window.parts).toBe(parts);
  });
});

function lines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `line ${String(index)}`,
  ).join("\n");
}

function countLines(parts: readonly RenderedPart[]): number {
  return parts.reduce(
    (total, part) =>
      total + (part.kind === "spinner" ? 1 : part.text.split("\n").length),
    0,
  );
}

function textPart(index: number, text: string): RenderedPart {
  return {
    color: undefined,
    dimColor: false,
    indent: 0,
    index,
    kind: "text",
    text,
  };
}

function segmentedTextPart(index: number, text: string): RenderedPart {
  return {
    color: undefined,
    dimColor: false,
    indent: 2,
    index,
    kind: "text",
    segments: [{ color: "cyan", text }],
    text,
  };
}

function spinnerPart(index: number): RenderedPart {
  return {
    index,
    kind: "spinner",
    label: "Running tool...",
  };
}
