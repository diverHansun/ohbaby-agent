import { describe, expect, it } from "vitest";
import { readTokenUsageMetadata } from "./token-usage-metadata.js";

describe("readTokenUsageMetadata", () => {
  it("round-trips canonical cache-aware usage", () => {
    const tokenUsage = {
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 2,
        observed: { cacheRead: true, cacheWrite: true },
        uncached: 2,
      },
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    } as const;

    expect(readTokenUsageMetadata({ tokenUsage })).toEqual(tokenUsage);
  });

  it("reads legacy metadata without inventing cache breakdown", () => {
    expect(
      readTokenUsageMetadata({
        tokenUsage: {
          completionTokens: 3,
          promptTokens: 10,
          totalTokens: 999,
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });
});
