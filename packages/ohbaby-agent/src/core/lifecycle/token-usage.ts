import type { TokenUsage } from "ohbaby-llm";
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

  const currentCache =
    current?.cachedInputTokens ??
    (current?.inputBreakdown?.observed.cacheRead
      ? current.inputBreakdown.cacheRead
      : undefined);
  const nextCache = next?.inputBreakdown?.observed.cacheRead
    ? next.inputBreakdown.cacheRead
    : undefined;
  const knownCache =
    currentCache === undefined && nextCache === undefined
      ? undefined
      : (currentCache ?? 0) + (nextCache ?? 0);

  if (next === undefined) {
    return {
      ...(knownCache === undefined ? {} : { cachedInputTokens: knownCache }),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      usageComplete: false,
    };
  }

  const nextInputTokens = inputTokens + next.inputTokens;
  const nextOutputTokens = outputTokens + next.outputTokens;
  const inputBreakdown = combineBreakdown(current, next, usageComplete);
  // A missing detail in any request makes the aggregate detail unknown.
  const reasoningTokens =
    usageComplete &&
    next.reasoningTokens !== undefined &&
    (current === undefined || current.reasoningTokens !== undefined)
      ? (current?.reasoningTokens ?? 0) + next.reasoningTokens
      : undefined;
  return {
    ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
    ...(inputBreakdown?.observed.cacheRead || knownCache === undefined
      ? {}
      : { cachedInputTokens: knownCache }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    inputTokens: nextInputTokens,
    outputTokens: nextOutputTokens,
    totalTokens: nextInputTokens + nextOutputTokens,
    usageComplete,
  };
}
