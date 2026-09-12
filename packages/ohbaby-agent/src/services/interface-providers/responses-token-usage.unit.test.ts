import { describe, expect, it, vi } from "vitest";
import { normalizeOpenAIResponsesUsage } from "./token-usage.js";

describe("Responses usage normalization", () => {
  it.each([
    [
      { cached_tokens: 40 },
      {
        uncached: 60,
        cacheRead: 40,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
      },
    ],
    [
      { cached_tokens: 40, cache_write_tokens: 10 },
      {
        uncached: 50,
        cacheRead: 40,
        cacheWrite: 10,
        observed: { cacheRead: true, cacheWrite: true },
      },
    ],
    [
      { cache_write_tokens: 10 },
      {
        uncached: 90,
        cacheRead: 0,
        cacheWrite: 10,
        observed: { cacheRead: false, cacheWrite: true },
      },
    ],
    [
      { cached_tokens: 0 },
      {
        uncached: 100,
        cacheRead: 0,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
      },
    ],
  ])(
    "keeps inclusive input and observed cache fields for %j",
    (details, expected) => {
      expect(
        normalizeOpenAIResponsesUsage({
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: details,
        }),
      ).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputBreakdown: expected,
      });
    },
  );
  it.each([undefined, {}, { unrelated_detail: 10 }])(
    "omits unobserved breakdown for %j",
    (details) => {
      expect(
        normalizeOpenAIResponsesUsage({
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: details,
          cache_read_input_tokens: 99,
        }),
      ).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    },
  );
  it.each([
    { cached_tokens: -1 },
    { cached_tokens: 1.1 },
    { cached_tokens: "40" },
    { cached_tokens: null },
    { cached_tokens: 90, cache_write_tokens: 11 },
    { cached_tokens: 40, cache_write_tokens: -1 },
    { cache_write_tokens: NaN },
  ])(
    "diagnoses invalid details while retaining trusted totals: %j",
    (details) => {
      const report = vi.fn();
      expect(
        normalizeOpenAIResponsesUsage(
          {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: details,
          },
          report,
        ),
      ).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
      expect(report.mock.calls).toEqual([
        [
          {
            type: "llm.usage.normalization",
            protocol: "openai-responses",
            code: "input-breakdown-conflict",
          },
        ],
      ]);
    },
  );
  it("diagnoses raw total mismatch with the Responses protocol", () => {
    const report = vi.fn();
    expect(
      normalizeOpenAIResponsesUsage(
        { input_tokens: 100, output_tokens: 20, total_tokens: 999 },
        report,
      )?.totalTokens,
    ).toBe(120);
    expect(report).toHaveBeenCalledWith({
      type: "llm.usage.normalization",
      protocol: "openai-responses",
      code: "raw-total-mismatch",
      received: 999,
      normalizedTotal: 120,
    });
  });
  it.each([
    null,
    {},
    { prompt_tokens: 100, completion_tokens: 20 },
    { input_tokens: -1, output_tokens: 20 },
    { input_tokens: 100, output_tokens: 1.1 },
  ])(
    "does not guess trusted totals from invalid/other protocol usage: %j",
    (raw) => {
      expect(normalizeOpenAIResponsesUsage(raw)).toBeUndefined();
    },
  );
});
