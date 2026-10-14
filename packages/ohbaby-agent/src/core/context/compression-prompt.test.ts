import { describe, expect, it } from "vitest";
import { COMPRESSION_PROMPT } from "./compression-prompt.js";

describe("compression prompts", () => {
  it("uses structured continuation sections with explicit compression pressure", () => {
    for (const section of [
      "## Goal",
      "## Current State",
      "## Key Decisions",
      "## User Intent & Feedback",
      "## Relevant Files",
      "## Next Steps",
      "## Risks",
    ]) {
      expect(COMPRESSION_PROMPT).toContain(section);
    }

    expect(COMPRESSION_PROMPT).toMatch(/16384/);
    expect(COMPRESSION_PROMPT).toMatch(/Do not mention.*summar/i);
  });

  it("declares summary-only behavior without a second prompt", async () => {
    const promptModule = (await import("./compression-prompt.js")) as {
      readonly AGGRESSIVE_COMPRESSION_PROMPT?: string;
    };

    expect(COMPRESSION_PROMPT).toMatch(/without tools/i);
    expect(COMPRESSION_PROMPT).toMatch(/language/i);
    expect(promptModule.AGGRESSIVE_COMPRESSION_PROMPT).toBeUndefined();
  });
});
