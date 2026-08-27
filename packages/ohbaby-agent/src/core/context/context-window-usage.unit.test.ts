import { describe, expect, it } from "vitest";
import {
  contextUsageToContextWindowUsage,
  createContextWindowUsageTracker,
} from "./context-window-usage.js";
import type { ContextUsage } from "./types.js";

const BASE_USAGE: ContextUsage = {
  contextLimit: 1_000_000,
  currentTokens: 38_400,
  inputBudgetTokens: 950_000,
  modelId: "deepseek-v4-pro",
  remainingTokens: 911_600,
  usageRatio: 38_400 / 950_000,
};

const COMPOSITION = {
  "system-prompt": 10_000,
  "builtin-tools": 5_000,
  mcp: 2_000,
  skills: 1_000,
  conversation: 15_000,
  "summarized-conversation": 4_000,
  "subagent-exchanges": 1_400,
} as const;

describe("context window usage mapping", () => {
  it("uses the full context window as the UI ratio denominator", () => {
    const usage = contextUsageToContextWindowUsage({
      now: () => "2026-06-06T00:00:00.000Z",
      sessionId: "session_1",
      usage: BASE_USAGE,
    });

    expect(usage).toEqual({
      contextWindowRatio: 0.0384,
      contextWindowTokens: 1_000_000,
      currentTokens: 38_400,
      estimatedAt: "2026-06-06T00:00:00.000Z",
      modelId: "deepseek-v4-pro",
      sessionId: "session_1",
    });
  });

  it("returns null when the context window is unavailable", () => {
    const usage = contextUsageToContextWindowUsage({
      sessionId: "session_1",
      usage: {
        ...BASE_USAGE,
        contextLimit: 0,
      },
    });

    expect(usage).toBeNull();
  });

  it("projects optional composition without changing total occupancy", () => {
    const usage = contextUsageToContextWindowUsage({
      composition: COMPOSITION,
      now: () => "2026-06-06T00:00:00.000Z",
      sessionId: "session_1",
      usage: BASE_USAGE,
    });

    expect(usage).toMatchObject({
      composition: COMPOSITION,
      contextWindowRatio: 0.0384,
      currentTokens: 38_400,
    });
  });

  it("keeps memory-only usage per session", () => {
    const tracker = createContextWindowUsageTracker({
      now: () => "2026-06-06T00:00:00.000Z",
    });

    const first = tracker.updateFromContextUsage("session_1", BASE_USAGE);
    const second = tracker.updateFromContextUsage("session_2", {
      ...BASE_USAGE,
      currentTokens: 12_800,
      modelId: "other-model",
    });

    expect(tracker.get("session_1")).toEqual(first);
    expect(tracker.get("session_2")).toEqual(second);
    expect(tracker.get("missing")).toBeNull();
    expect(tracker.list().map((usage) => usage.sessionId)).toEqual([
      "session_1",
      "session_2",
    ]);
  });

  it("clears stale composition when a later update is total-only", () => {
    const tracker = createContextWindowUsageTracker({
      now: () => "2026-06-06T00:00:00.000Z",
    });

    tracker.updateFromContextUsage("session_1", BASE_USAGE, COMPOSITION);
    expect(tracker.get("session_1")?.composition).toEqual(COMPOSITION);

    tracker.updateFromContextUsage("session_1", {
      ...BASE_USAGE,
      currentTokens: 40_000,
    });

    expect(tracker.get("session_1")).not.toHaveProperty("composition");
    expect(tracker.get("session_1")?.currentTokens).toBe(40_000);
  });
});
