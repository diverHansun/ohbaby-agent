import type { TokenUsage } from "../llm-client/index.js";
import type { LifecycleTokenUsage } from "./types.js";

function combineBreakdown(
  current: LifecycleTokenUsage | undefined,
  next: TokenUsage,
  usageComplete: boolean,
): LifecycleTokenUsage["inputBreakdown"] {
  if (!usageComplete) {
    return undefined;
  }
  if (next.inputTokens === 0) {
    return current?.inputBreakdown;
  }
  if (next.inputBreakdown === undefined) {
    return undefined;
  }
  if (current === undefined || current.inputTokens === 0) {
    return next.inputBreakdown;
  }
  if (current.inputBreakdown === undefined) {
    return undefined;
  }

  return {
    cacheRead: current.inputBreakdown.cacheRead + next.inputBreakdown.cacheRead,
    cacheWrite:
      current.inputBreakdown.cacheWrite + next.inputBreakdown.cacheWrite,
    observed: {
      cacheRead:
        current.inputBreakdown.observed.cacheRead &&
        next.inputBreakdown.observed.cacheRead,
      cacheWrite:
        current.inputBreakdown.observed.cacheWrite &&
        next.inputBreakdown.observed.cacheWrite,
    },
    uncached: current.inputBreakdown.uncached + next.inputBreakdown.uncached,
  };
}

export function aggregateTokenUsage(
  current: LifecycleTokenUsage | undefined,
  next: TokenUsage | undefined,
): LifecycleTokenUsage {
  const inputTokens = current?.inputTokens ?? 0;
  const outputTokens = current?.outputTokens ?? 0;
  const usageComplete = (current?.usageComplete ?? true) && next !== undefined;

  if (next === undefined) {
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      usageComplete: false,
    };
  }

  const nextInputTokens = inputTokens + next.inputTokens;
  const nextOutputTokens = outputTokens + next.outputTokens;
  const inputBreakdown = combineBreakdown(current, next, usageComplete);
  return {
    ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
    inputTokens: nextInputTokens,
    outputTokens: nextOutputTokens,
    totalTokens: nextInputTokens + nextOutputTokens,
    usageComplete,
  };
}
