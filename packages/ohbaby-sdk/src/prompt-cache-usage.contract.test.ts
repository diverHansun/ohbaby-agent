import { describe, expect, it } from "vitest";
import type { UiPromptCacheUsage } from "./index.js";

describe("prompt cache usage UI contract", () => {
  it("represents session-scoped cache-read accounting", () => {
    const usage: UiPromptCacheUsage = {
      accountedInputTokens: 4_000,
      cacheReadShare: 0.6,
      cacheReadTokens: 2_400,
      sessionId: "session_1",
    };

    expect(usage).toEqual({
      accountedInputTokens: 4_000,
      cacheReadShare: 0.6,
      cacheReadTokens: 2_400,
      sessionId: "session_1",
    });
  });

  it("keeps unknown cache-read share distinct from zero", () => {
    const usage: UiPromptCacheUsage = {
      accountedInputTokens: 0,
      cacheReadShare: null,
      cacheReadTokens: 0,
      sessionId: "session_1",
    };

    expect(usage.cacheReadShare).toBeNull();
  });
});
