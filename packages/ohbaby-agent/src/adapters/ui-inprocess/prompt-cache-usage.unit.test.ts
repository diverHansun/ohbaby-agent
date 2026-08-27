import { describe, expect, it } from "vitest";
import { aggregateTokenUsage } from "../../core/lifecycle/token-usage.js";
import type { LifecycleTokenUsage } from "../../core/lifecycle/types.js";
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
        usageComplete: true,
      }),
    ).toBeNull();
    expect(cacheReadShareFromUsage(usage({ usageComplete: false }))).toBeNull();
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

  it("derives the share from cumulative tokens instead of averaging runs", () => {
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

  it("skips an incomplete run without changing the previous totals", () => {
    const tracker = createPromptCacheUsageTracker();
    tracker.record("session_1", usage({ cacheRead: 200, uncached: 800 }));

    expect(
      tracker.record("session_1", usage({ usageComplete: false })),
    ).toEqual({
      accountedInputTokens: 1_000,
      cacheReadShare: 0.2,
      cacheReadTokens: 200,
      sessionId: "session_1",
    });
  });

  it("skips a multi-step run when any non-zero step omits its breakdown", () => {
    const first = aggregateTokenUsage(undefined, {
      inputBreakdown: breakdown({ cacheRead: 200, uncached: 800 }),
      inputTokens: 1_000,
      outputTokens: 10,
      totalTokens: 1_010,
    });
    const second = aggregateTokenUsage(first, {
      inputTokens: 500,
      outputTokens: 10,
      totalTokens: 510,
    });
    const third = aggregateTokenUsage(second, {
      inputBreakdown: breakdown({ cacheRead: 600, uncached: 400 }),
      inputTokens: 1_000,
      outputTokens: 10,
      totalTokens: 1_010,
    });
    const tracker = createPromptCacheUsageTracker();

    expect(third.inputBreakdown).toBeUndefined();
    expect(tracker.record("session_1", third)).toEqual({
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
    readonly usageComplete?: boolean;
  } = {},
): LifecycleTokenUsage {
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
    usageComplete: overrides.usageComplete ?? true,
  };
}

function breakdown(
  overrides: {
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly observedCacheRead?: boolean;
    readonly uncached?: number;
  } = {},
): NonNullable<LifecycleTokenUsage["inputBreakdown"]> {
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
