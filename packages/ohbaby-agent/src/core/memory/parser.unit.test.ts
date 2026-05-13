import { describe, expect, it } from "vitest";
import {
  computeAddedMemoryContent,
  parseMemoryEntries,
  removeMemoryEntry,
  updateMemoryEntry,
} from "./memory-parser.js";

describe("memory parser", () => {
  it("parses only AI-added memory entries below the managed header", () => {
    const entries = parseMemoryEntries(
      `
# User Notes

- not managed

## Ohbaby Added Memories

intro text
- 2026-01-01 20:00:00: First fact
- 2026-01-01 20:05:00: Second fact
`.trim(),
    );

    expect(entries).toEqual([
      {
        index: 0,
        timestamp: "2026-01-01 20:00:00",
        text: "First fact",
      },
      {
        index: 1,
        timestamp: "2026-01-01 20:05:00",
        text: "Second fact",
      },
    ]);
  });

  it("adds the managed header without disturbing user-written content", () => {
    const content = computeAddedMemoryContent(
      "# Rules\n\nKeep this area intact.",
      "Remember Vitest",
      "2026-01-01 22:00:00",
    );

    expect(content).toBe(
      "# Rules\n\nKeep this area intact.\n\n## Ohbaby Added Memories\n\n- 2026-01-01 22:00:00: Remember Vitest",
    );
  });

  it("updates and removes entries while preserving timestamps and user content", () => {
    const content = `
# Manual Area

## Ohbaby Added Memories

- 2026-01-01 20:00:00: Old one
- 2026-01-01 20:05:00: Old two
`.trim();

    const updated = updateMemoryEntry(content, 1, "New two");
    expect(updated).toContain("# Manual Area");
    expect(updated).toContain("- 2026-01-01 20:00:00: Old one");
    expect(updated).toContain("- 2026-01-01 20:05:00: New two");
    expect(updated).not.toContain("Old two");

    const removed = removeMemoryEntry(updated, 0);
    expect(parseMemoryEntries(removed)).toEqual([
      {
        index: 0,
        timestamp: "2026-01-01 20:05:00",
        text: "New two",
      },
    ]);
  });
});
