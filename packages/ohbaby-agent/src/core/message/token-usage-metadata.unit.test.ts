import { describe, expect, it } from "vitest";
import {
  createTokenUsageMetadata,
  readTokenUsageMetadata,
} from "./token-usage-metadata.js";

describe("createTokenUsageMetadata", () => {
  it("creates canonical metadata and recomputes total tokens", () => {
    expect(
      createTokenUsageMetadata({
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 999,
      }),
    ).toEqual({
      tokenUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    });
  });

  it("copies cache breakdown and observed flags", () => {
    const inputBreakdown = {
      cacheRead: 6,
      cacheWrite: 2,
      observed: { cacheRead: true, cacheWrite: true },
      uncached: 2,
    } as const;
    const tokenUsage = {
      inputBreakdown,
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    } as const;

    const metadata = createTokenUsageMetadata(tokenUsage);

    expect(metadata).toEqual({ tokenUsage });
    expect(metadata?.tokenUsage).not.toBe(tokenUsage);
    expect(metadata?.tokenUsage?.inputBreakdown).not.toBe(inputBreakdown);
    expect(metadata?.tokenUsage?.inputBreakdown?.observed).not.toBe(
      inputBreakdown.observed,
    );
  });

  it("does not create empty metadata when usage is missing", () => {
    expect(createTokenUsageMetadata(undefined)).toBeUndefined();
  });
});

describe("readTokenUsageMetadata", () => {
  it("reads canonical cache-aware usage and recomputes total tokens", () => {
    expect(
      readTokenUsageMetadata({
        tokenUsage: {
          inputBreakdown: {
            cacheRead: 6,
            cacheWrite: 2,
            observed: { cacheRead: true, cacheWrite: true },
            uncached: 2,
          },
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 999,
        },
      }),
    ).toEqual({
      inputBreakdown: {
        cacheRead: 6,
        cacheWrite: 2,
        observed: { cacheRead: true, cacheWrite: true },
        uncached: 2,
      },
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
    });
  });

  it.each([
    ["breakdown sum", { cacheRead: 7, cacheWrite: 2, uncached: 2 }],
    ["negative breakdown", { cacheRead: -1, cacheWrite: 2, uncached: 9 }],
    ["fractional breakdown", { cacheRead: 6.5, cacheWrite: 2, uncached: 1.5 }],
    ["string breakdown", { cacheRead: "6", cacheWrite: 2, uncached: 2 }],
    ["NaN breakdown", { cacheRead: Number.NaN, cacheWrite: 2, uncached: 2 }],
    [
      "infinite breakdown",
      { cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 2, uncached: 2 },
    ],
  ])("keeps canonical totals when %s is invalid", (_name, breakdown) => {
    expect(
      readTokenUsageMetadata({
        tokenUsage: {
          inputBreakdown: {
            ...breakdown,
            observed: { cacheRead: true, cacheWrite: true },
          },
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 13,
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { tokenUsage: null },
    { tokenUsage: [] },
    { tokenUsage: { inputTokens: -1, outputTokens: 3 } },
    { tokenUsage: { inputTokens: 1.5, outputTokens: 3 } },
    { tokenUsage: { inputTokens: "10", outputTokens: 3 } },
    { tokenUsage: { inputTokens: Number.NaN, outputTokens: 3 } },
    { tokenUsage: { inputTokens: Number.MAX_VALUE, outputTokens: 3 } },
    {
      tokenUsage: {
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: 3,
      },
    },
    {
      tokenUsage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
      },
    },
  ])("rejects invalid metadata %#", (metadata) => {
    expect(readTokenUsageMetadata(metadata)).toBeUndefined();
  });

  it("drops a breakdown whose observed flags are incomplete", () => {
    expect(
      readTokenUsageMetadata({
        tokenUsage: {
          inputBreakdown: {
            cacheRead: 6,
            cacheWrite: 2,
            observed: { cacheRead: true },
            uncached: 2,
          },
          inputTokens: 10,
          outputTokens: 3,
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
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

  it("falls back to complete legacy metadata when canonical totals are invalid", () => {
    expect(
      readTokenUsageMetadata({
        tokenUsage: {
          completionTokens: 3,
          inputTokens: "invalid",
          outputTokens: 3,
          promptTokens: 10,
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });
});
