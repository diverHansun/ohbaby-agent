import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../../core/llm-client/index.js";
import {
  cacheReadShareFromUsage,
  createPromptCacheUsageTracker,
} from "./prompt-cache-usage.js";

describe("prompt cache usage", () => {
  it("keeps unavailable cache-read accounting distinct from zero", () => {
    expect(cacheReadShareFromUsage(undefined)).toBeNull();
    expect(
      cacheReadShareFromUsage(usage({ observedCacheRead: false })),
    ).toBeNull();
    expect(
      cacheReadShareFromUsage({
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
      }),
    ).toBeNull();
  });

  it("counts observed zero cache reads and does not require cache-write observation", () => {
    const tracker = createPromptCacheUsageTracker();

    expect(
      tracker.record(
        "session_1",
        usage({ cacheRead: 0, cacheWrite: 200, uncached: 800 }),
      ),
    ).toEqual({
      accountedInputTokens: 1_000,
      cacheReadShare: 0,
      cacheReadTokens: 0,
      sessionId: "session_1",
    });
  });

  it("keeps a zero-token trusted sample unavailable", () => {
    const tracker = createPromptCacheUsageTracker();

    expect(
      tracker.record(
        "session_1",
        usage({ cacheRead: 0, cacheWrite: 0, uncached: 0 }),
      ),
    ).toEqual({
      accountedInputTokens: 0,
      cacheReadShare: null,
      cacheReadTokens: 0,
      sessionId: "session_1",
    });
  });

  it("derives the share from cumulative tokens instead of averaging steps", () => {
    const tracker = createPromptCacheUsageTracker();
    tracker.record("session_1", usage({ cacheRead: 200, uncached: 800 }));

    expect(
      tracker.record("session_1", usage({ cacheRead: 2_200, uncached: 800 })),
    ).toEqual({
      accountedInputTokens: 4_000,
      cacheReadShare: 0.6,
      cacheReadTokens: 2_400,
      sessionId: "session_1",
    });
  });

  it("keeps trusted steps around a missing-usage or missing-breakdown step", () => {
    const tracker = createPromptCacheUsageTracker();
    tracker.record("session_1", usage({ cacheRead: 800, uncached: 200 }));
    tracker.record("session_1", undefined);
    tracker.record("session_1", {
      inputTokens: 2_000,
      outputTokens: 10,
      totalTokens: 2_010,
    });
    expect(
      tracker.record("session_1", usage({ cacheRead: 600, uncached: 400 })),
    ).toEqual({
      accountedInputTokens: 2_000,
      cacheReadShare: 0.7,
      cacheReadTokens: 1_400,
      sessionId: "session_1",
    });
  });

  it.each([
    { inputTokens: 999 },
    { inputTokens: -1 },
    { inputTokens: 1.5 },
    { outputTokens: -1 },
    { totalTokens: Number.NaN },
    { totalTokens: 1_011 },
    { inputBreakdown: breakdown({ cacheRead: -1, uncached: 1_001 }) },
    { inputBreakdown: breakdown({ cacheRead: 200.5, uncached: 799.5 }) },
    { inputBreakdown: breakdown({ cacheRead: Number.POSITIVE_INFINITY }) },
    { inputBreakdown: breakdown({ observedCacheRead: false }) },
  ])("rejects malformed or unreadable canonical usage %j", (overrides) => {
    const tracker = createPromptCacheUsageTracker();
    expect(tracker.record("session_1", { ...usage(), ...overrides })).toEqual({
      accountedInputTokens: 0,
      cacheReadShare: null,
      cacheReadTokens: 0,
      sessionId: "session_1",
    });
  });

  it("clears one session or every session without coupling to compaction", () => {
    const tracker = createPromptCacheUsageTracker();
    tracker.record("session_1", usage({ cacheRead: 200, uncached: 800 }));
    tracker.record("session_2", usage({ cacheRead: 500, uncached: 500 }));

    tracker.clearSession("session_1");
    expect(tracker.get("session_1").cacheReadShare).toBeNull();
    expect(tracker.get("session_2").cacheReadShare).toBe(0.5);

    tracker.clear();
    expect(tracker.get("session_2").cacheReadShare).toBeNull();
  });
});

function usage(
  overrides: {
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly observedCacheRead?: boolean;
    readonly uncached?: number;
  } = {},
): TokenUsage {
  const inputBreakdown = breakdown(overrides);
  const inputTokens =
    inputBreakdown.uncached +
    inputBreakdown.cacheRead +
    inputBreakdown.cacheWrite;
  return {
    inputBreakdown,
    inputTokens,
    outputTokens: 10,
    totalTokens: inputTokens + 10,
  };
}

function breakdown(
  overrides: {
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly observedCacheRead?: boolean;
    readonly uncached?: number;
  } = {},
): NonNullable<TokenUsage["inputBreakdown"]> {
  return {
    cacheRead: overrides.cacheRead ?? 200,
    cacheWrite: overrides.cacheWrite ?? 0,
    observed: {
      cacheRead: overrides.observedCacheRead ?? true,
      cacheWrite: false,
    },
    uncached: overrides.uncached ?? 800,
  };
}
