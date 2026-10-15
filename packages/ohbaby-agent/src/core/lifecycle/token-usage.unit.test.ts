import { describe, expect, it } from "vitest";
import { aggregateTokenUsage } from "./token-usage.js";

describe("aggregateTokenUsage", () => {
  it("retains known cache reads across missing usage without claiming a complete breakdown", () => {
    const known = {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 0,
        uncached: 4,
        observed: { cacheRead: true, cacheWrite: true },
      },
    };
    for (const missing of [
      undefined,
      { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    ]) {
      for (const pair of [
        [known, missing],
        [missing, known],
      ]) {
        const result = aggregateTokenUsage(
          aggregateTokenUsage(undefined, pair[0]),
          pair[1],
        );
        expect(result.cachedInputTokens).toBe(6);
        expect(result.inputBreakdown).toBeUndefined();
      }
    }
  });
  it("sums disjoint input buckets and ANDs observed flags", () => {
    const first = aggregateTokenUsage(undefined, {
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 4,
      },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    expect(
      aggregateTokenUsage(first, {
        inputBreakdown: {
          cacheRead: 3,
          cacheWrite: 2,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 5,
        },
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      }),
    ).toEqual({
      inputBreakdown: {
        cacheRead: 9,
        cacheWrite: 2,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 9,
      },
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      usageComplete: true,
    });
  });

  it("removes aggregate breakdown when any non-zero request omits it", () => {
    const first = aggregateTokenUsage(undefined, {
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 4,
      },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    expect(
      aggregateTokenUsage(first, {
        inputTokens: 5,
        outputTokens: 1,
        totalTokens: 6,
      }),
    ).toEqual({
      cachedInputTokens: 6,
      inputTokens: 15,
      outputTokens: 3,
      totalTokens: 18,
      usageComplete: true,
    });
  });

  it("marks known totals as a lower bound when a complete request omits usage", () => {
    const first = aggregateTokenUsage(undefined, {
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 4,
      },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    expect(aggregateTokenUsage(first, undefined)).toEqual({
      cachedInputTokens: 6,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      usageComplete: false,
    });
  });

  it("does not let a zero-input request erase an otherwise complete breakdown", () => {
    const first = aggregateTokenUsage(undefined, {
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 4,
      },
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    expect(
      aggregateTokenUsage(first, {
        inputTokens: 0,
        outputTokens: 1,
        totalTokens: 1,
      }),
    ).toEqual({
      inputBreakdown: first.inputBreakdown,
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      usageComplete: true,
    });
  });
});

describe("aggregate reasoning usage", () => {
  const known = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
  };
  it("sums fully reported reasoning without adding it to output or total", () => {
    expect(
      aggregateTokenUsage(aggregateTokenUsage(undefined, known), {
        ...known,
        reasoningTokens: 0,
      }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      reasoningTokens: 3,
      usageComplete: true,
    });
  });
  it.each([
    undefined,
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])(
    "keeps partial reasoning unknown regardless of request order %#",
    (unknown) => {
      expect(
        aggregateTokenUsage(aggregateTokenUsage(undefined, known), unknown),
      ).not.toHaveProperty("reasoningTokens");
      expect(
        aggregateTokenUsage(aggregateTokenUsage(undefined, unknown), known),
      ).not.toHaveProperty("reasoningTokens");
    },
  );
});
