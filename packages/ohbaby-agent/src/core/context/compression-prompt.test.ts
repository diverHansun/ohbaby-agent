import { describe, expect, it } from "vitest";
import {
  COMPRESSION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./compression-prompt.js";

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

    expect(COMPRESSION_PROMPT).toMatch(/15-30%|one third/i);
    expect(COMPRESSION_PROMPT).toMatch(/Do not mention.*summar/i);
  });

  it("declares summary-only behavior and exposes an aggressive retry prompt", async () => {
    const promptModule = (await import("./compression-prompt.js")) as {
      readonly AGGRESSIVE_COMPRESSION_PROMPT?: string;
    };

    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/do not.*tool/i);
    expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/same language/i);
    expect(promptModule.AGGRESSIVE_COMPRESSION_PROMPT).toEqual(
      expect.stringMatching(/CRITICAL|too long|compress aggressively/i),
    );
  });
});
