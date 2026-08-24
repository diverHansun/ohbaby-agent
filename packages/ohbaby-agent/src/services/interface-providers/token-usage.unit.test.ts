import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicUsageAccumulator,
  normalizeOpenAICompatibleUsage,
} from "./token-usage.js";
import type { TokenUsageNormalizationDiagnostic } from "./token-usage.js";
import type { InterfaceProviderTokenUsage } from "./types.js";

function expectUsage(
  actual: InterfaceProviderTokenUsage | undefined,
  expected: unknown,
): void {
  expect(actual).toEqual(expected);
  if (actual === undefined) {
    return;
  }

  for (const value of [
    actual.inputTokens,
    actual.outputTokens,
    actual.totalTokens,
  ]) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(actual.totalTokens).toBe(actual.inputTokens + actual.outputTokens);

  const breakdown = actual.inputBreakdown;
  if (breakdown === undefined) {
    return;
  }
  for (const value of [
    breakdown.cacheRead,
    breakdown.cacheWrite,
    breakdown.uncached,
  ]) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(breakdown.cacheRead + breakdown.cacheWrite + breakdown.uncached).toBe(
    actual.inputTokens,
  );
  const cacheHitRate =
    actual.inputTokens === 0 ? 0 : breakdown.cacheRead / actual.inputTokens;
  expect(cacheHitRate).toBeLessThanOrEqual(1);
}

describe("normalizeOpenAICompatibleUsage", () => {
  it.each([
    {
      name: "keeps inclusive OpenAI input without inventing cache buckets",
      raw: {
        completion_tokens: 5,
        prompt_tokens: 10,
        total_tokens: 999,
      },
      expected: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    },
    {
      name: "distinguishes an observed cached-token miss from unavailable write data",
      raw: {
        completion_tokens: 2,
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 0 },
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 0,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 10,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    {
      name: "normalizes a positive nested cached-token read without inventing write data",
      raw: {
        completion_tokens: 2,
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 6 },
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 6,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 4,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    {
      name: "normalizes disjoint OpenAI read and write buckets",
      raw: {
        completion_tokens: 3,
        prompt_tokens: 20,
        prompt_tokens_details: {
          cache_write_tokens: 4,
          cached_tokens: 6,
        },
        total_tokens: 23,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 6,
          cacheWrite: 4,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 10,
        },
        inputTokens: 20,
        outputTokens: 3,
        totalTokens: 23,
      },
    },
    {
      name: "drops an impossible breakdown while retaining inclusive totals",
      raw: {
        completion_tokens: 3,
        prompt_tokens: 5,
        prompt_tokens_details: {
          cache_write_tokens: 4,
          cached_tokens: 6,
        },
        total_tokens: 8,
      },
      expected: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      },
    },
    {
      name: "derives a DeepSeek miss bucket from prompt and hit",
      raw: {
        completion_tokens: 2,
        prompt_cache_hit_tokens: 7,
        prompt_tokens: 10,
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 7,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 3,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    {
      name: "derives a DeepSeek hit bucket from prompt and miss",
      raw: {
        completion_tokens: 2,
        prompt_cache_miss_tokens: 3,
        prompt_tokens: 10,
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 7,
          cacheWrite: 0,
          observed: { cacheRead: false, cacheWrite: false },
          uncached: 3,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    {
      name: "derives DeepSeek input from hit and miss when prompt is absent",
      raw: {
        completion_tokens: 2,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 7,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 3,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
    {
      name: "prefers nested cached tokens over Kimi-compatible top-level data",
      raw: {
        cached_tokens: 9,
        completion_tokens: 2,
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4 },
        total_tokens: 12,
      },
      expected: {
        inputBreakdown: {
          cacheRead: 4,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 6,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    },
  ])("$name", ({ raw, expected }) => {
    expectUsage(normalizeOpenAICompatibleUsage(raw), expected);
  });

  it("rejects incomplete DeepSeek input accounting without a prompt total", () => {
    expect(
      normalizeOpenAICompatibleUsage({
        completion_tokens: 2,
        prompt_cache_hit_tokens: 7,
        total_tokens: 9,
      }),
    ).toBeUndefined();
  });

  it("drops a conflicting DeepSeek breakdown without changing inclusive totals", () => {
    expectUsage(
      normalizeOpenAICompatibleUsage({
        completion_tokens: 2,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 4,
        prompt_tokens: 10,
        total_tokens: 12,
      }),
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    );
  });

  it("never derives a negative DeepSeek hit when miss exceeds prompt", () => {
    const diagnostics: TokenUsageNormalizationDiagnostic[] = [];

    expectUsage(
      normalizeOpenAICompatibleUsage(
        {
          completion_tokens: 2,
          prompt_cache_miss_tokens: 12,
          prompt_tokens: 10,
          total_tokens: 12,
        },
        (diagnostic) => diagnostics.push(diagnostic),
      ),
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    );
    expect(diagnostics).toContainEqual({
      code: "input-breakdown-conflict",
      protocol: "openai-compatible",
      type: "llm.usage.normalization",
    });
  });

  it("normalizes Kimi top-level cached tokens when nested details are absent", () => {
    expectUsage(
      normalizeOpenAICompatibleUsage({
        cached_tokens: 4,
        completion_tokens: 2,
        prompt_tokens: 10,
        total_tokens: 12,
      }),
      {
        inputBreakdown: {
          cacheRead: 4,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 6,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    );
  });

  it("reports structured diagnostics for raw total and breakdown conflicts", () => {
    const diagnostics: TokenUsageNormalizationDiagnostic[] = [];

    normalizeOpenAICompatibleUsage(
      {
        completion_tokens: 3,
        prompt_tokens: 5,
        prompt_tokens_details: {
          cache_write_tokens: 4,
          cached_tokens: 6,
        },
        total_tokens: 999,
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(diagnostics).toEqual([
      {
        code: "input-breakdown-conflict",
        protocol: "openai-compatible",
        type: "llm.usage.normalization",
      },
      {
        code: "raw-total-mismatch",
        normalizedTotal: 8,
        protocol: "openai-compatible",
        received: 999,
        type: "llm.usage.normalization",
      },
    ]);
  });
});

describe("createAnthropicUsageAccumulator", () => {
  it("keeps raw Anthropic input inclusive when no cache fields are reported", () => {
    const usage = createAnthropicUsageAccumulator();

    expectUsage(usage.update({ input_tokens: 10, output_tokens: 2 }), {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  it("distinguishes explicit zero cache buckets from missing fields", () => {
    const usage = createAnthropicUsageAccumulator();

    expectUsage(
      usage.update({
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 10,
        output_tokens: 2,
      }),
      {
        inputBreakdown: {
          cacheRead: 0,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 10,
        },
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    );
  });

  it("adds Anthropic uncached, creation, and read input exactly once", () => {
    const usage = createAnthropicUsageAccumulator();

    expectUsage(
      usage.update({
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 6,
        input_tokens: 10,
        output_tokens: 3,
      }),
      {
        inputBreakdown: {
          cacheRead: 6,
          cacheWrite: 4,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 10,
        },
        inputTokens: 20,
        outputTokens: 3,
        totalTokens: 23,
      },
    );
  });

  it.each([
    {
      cache: { cache_creation_input_tokens: 4 },
      expected: {
        cacheRead: 0,
        cacheWrite: 4,
        observed: { cacheRead: false, cacheWrite: true },
        uncached: 10,
      },
      name: "cache creation",
    },
    {
      cache: { cache_read_input_tokens: 6 },
      expected: {
        cacheRead: 6,
        cacheWrite: 0,
        observed: { cacheRead: true, cacheWrite: false },
        uncached: 10,
      },
      name: "cache read",
    },
  ])("normalizes Anthropic $name independently", ({ cache, expected }) => {
    const usage = createAnthropicUsageAccumulator();

    expectUsage(
      usage.update({ ...cache, input_tokens: 10, output_tokens: 3 }),
      {
        inputBreakdown: expected,
        inputTokens:
          expected.uncached + expected.cacheRead + expected.cacheWrite,
        outputTokens: 3,
        totalTokens:
          expected.uncached + expected.cacheRead + expected.cacheWrite + 3,
      },
    );
  });

  it("monotonically merges start and final usage without letting placeholders erase data", () => {
    const report = vi.fn();
    const usage = createAnthropicUsageAccumulator(report);

    usage.update({
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 6,
      input_tokens: 10,
      output_tokens: 0,
    });

    expectUsage(
      usage.update({
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 3,
      }),
      {
        inputBreakdown: {
          cacheRead: 6,
          cacheWrite: 4,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 10,
        },
        inputTokens: 20,
        outputTokens: 3,
        totalTokens: 23,
      },
    );
    expect(report).toHaveBeenCalledWith({
      code: "non-monotonic-cumulative-field",
      field: "input_tokens",
      protocol: "anthropic",
      received: 0,
      retained: 10,
      type: "llm.usage.normalization",
    });
  });

  it("accepts growing cumulative Anthropic fields after message start", () => {
    const usage = createAnthropicUsageAccumulator();

    usage.update({
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 6,
      input_tokens: 10,
      output_tokens: 0,
    });

    expectUsage(
      usage.update({
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 8,
        input_tokens: 12,
        output_tokens: 3,
      }),
      {
        inputBreakdown: {
          cacheRead: 8,
          cacheWrite: 5,
          observed: { cacheRead: true, cacheWrite: true },
          uncached: 12,
        },
        inputTokens: 25,
        outputTokens: 3,
        totalTokens: 28,
      },
    );
  });
});
