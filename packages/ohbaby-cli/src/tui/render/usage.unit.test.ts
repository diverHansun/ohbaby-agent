import { describe, expect, it } from "vitest";
import type { UiContextWindowUsage } from "ohbaby-sdk";
import { formatContextWindowUsage } from "./usage.js";

describe("formatContextWindowUsage", () => {
  it("formats current tokens, full context window, and integer percent", () => {
    expect(formatContextWindowUsage(usage(38_400, 1_000_000))).toBe(
      "38.4K / 1M (4%)",
    );
  });

  it("uses a less-than marker for non-zero usage below one percent", () => {
    expect(formatContextWindowUsage(usage(5_000, 1_000_000))).toBe(
      "5K / 1M (<1%)",
    );
  });

  it("keeps the existing total-only format when composition is present", () => {
    expect(
      formatContextWindowUsage({
        ...usage(38_400, 1_000_000),
        composition: {
          "system-prompt": 10_000,
          "builtin-tools": 5_000,
          mcp: 2_000,
          skills: 1_000,
          conversation: 15_000,
          "summarized-conversation": 4_000,
          "subagent-exchanges": 1_400,
        },
      }),
    ).toBe("38.4K / 1M (4%)");
  });

  it("returns an empty string when context window tokens are unavailable", () => {
    expect(formatContextWindowUsage(usage(5_000, 0))).toBe("");
    expect(formatContextWindowUsage(null)).toBe("");
  });
});

function usage(
  currentTokens: number,
  contextWindowTokens: number,
): UiContextWindowUsage {
  return {
    contextWindowRatio:
      contextWindowTokens > 0 ? currentTokens / contextWindowTokens : 0,
    contextWindowTokens,
    currentTokens,
    estimatedAt: "2026-06-06T00:00:00.000Z",
    modelId: "fake-model",
    sessionId: "session_1",
  };
}
