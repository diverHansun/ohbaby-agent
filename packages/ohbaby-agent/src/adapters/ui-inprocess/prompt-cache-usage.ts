import type { UiPromptCacheUsage } from "ohbaby-sdk";
import type { LifecycleTokenUsage } from "../../core/lifecycle/index.js";

interface PromptCacheUsageTotals {
  readonly accountedInputTokens: number;
  readonly cacheReadTokens: number;
}

interface PromptCacheUsageSample extends PromptCacheUsageTotals {
  readonly cacheReadShare: number;
}

export interface PromptCacheUsageTracker {
  clear(): void;
  clearSession(sessionId: string): void;
  get(sessionId: string): UiPromptCacheUsage;
  record(
    sessionId: string,
    usage: LifecycleTokenUsage | undefined,
  ): UiPromptCacheUsage;
}

export function cacheReadShareFromUsage(
  usage: LifecycleTokenUsage | undefined,
): number | null {
  return promptCacheUsageSample(usage)?.cacheReadShare ?? null;
}

export function createPromptCacheUsageTracker(): PromptCacheUsageTracker {
  const totalsBySession = new Map<string, PromptCacheUsageTotals>();

  function get(sessionId: string): UiPromptCacheUsage {
    const totals = totalsBySession.get(sessionId) ?? {
      accountedInputTokens: 0,
      cacheReadTokens: 0,
    };
    return promptCacheUsageFromTotals(sessionId, totals);
  }

  return {
    clear(): void {
      totalsBySession.clear();
    },

    clearSession(sessionId: string): void {
      totalsBySession.delete(sessionId);
    },

    get,

    record(
      sessionId: string,
      usage: LifecycleTokenUsage | undefined,
    ): UiPromptCacheUsage {
      const sample = promptCacheUsageSample(usage);
      if (!sample) {
        return get(sessionId);
      }

      const current = totalsBySession.get(sessionId);
      const next: PromptCacheUsageTotals = {
        accountedInputTokens:
          (current?.accountedInputTokens ?? 0) + sample.accountedInputTokens,
        cacheReadTokens:
          (current?.cacheReadTokens ?? 0) + sample.cacheReadTokens,
      };
      totalsBySession.set(sessionId, next);
      return promptCacheUsageFromTotals(sessionId, next);
    },
  };
}

function promptCacheUsageSample(
  usage: LifecycleTokenUsage | undefined,
): PromptCacheUsageSample | null {
  const breakdown = usage?.inputBreakdown;
  if (usage?.usageComplete !== true || breakdown?.observed.cacheRead !== true) {
    return null;
  }

  const accountedInputTokens =
    breakdown.uncached + breakdown.cacheRead + breakdown.cacheWrite;
  if (
    !isNonNegativeInteger(breakdown.uncached) ||
    !isNonNegativeInteger(breakdown.cacheRead) ||
    !isNonNegativeInteger(breakdown.cacheWrite) ||
    !isNonNegativeInteger(accountedInputTokens) ||
    accountedInputTokens === 0 ||
    breakdown.cacheRead > accountedInputTokens
  ) {
    return null;
  }

  return {
    accountedInputTokens,
    cacheReadShare: breakdown.cacheRead / accountedInputTokens,
    cacheReadTokens: breakdown.cacheRead,
  };
}

function promptCacheUsageFromTotals(
  sessionId: string,
  totals: PromptCacheUsageTotals,
): UiPromptCacheUsage {
  return {
    accountedInputTokens: totals.accountedInputTokens,
    cacheReadShare:
      totals.accountedInputTokens === 0
        ? null
        : totals.cacheReadTokens / totals.accountedInputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    sessionId,
  };
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
