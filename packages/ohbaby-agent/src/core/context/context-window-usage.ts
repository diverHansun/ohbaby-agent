import type { UiContextWindowUsage } from "ohbaby-sdk";
import type { ContextUsage } from "./types.js";

export interface ContextWindowUsageInput {
  readonly sessionId: string;
  readonly usage: ContextUsage;
  readonly now?: () => string;
}

export interface ContextWindowUsageTracker {
  clear(): void;
  get(sessionId: string): UiContextWindowUsage | null;
  list(): readonly UiContextWindowUsage[];
  updateFromContextUsage(
    sessionId: string,
    usage: ContextUsage,
  ): UiContextWindowUsage | null;
}

export interface ContextWindowUsageTrackerOptions {
  readonly now?: () => string;
}

export function contextUsageToContextWindowUsage(
  input: ContextWindowUsageInput,
): UiContextWindowUsage | null {
  const contextWindowTokens = input.usage.contextLimit;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return null;
  }

  const currentTokens = Math.max(0, input.usage.currentTokens);
  return {
    contextWindowRatio: currentTokens / contextWindowTokens,
    contextWindowTokens,
    currentTokens,
    estimatedAt: input.now?.() ?? new Date().toISOString(),
    modelId: input.usage.modelId,
    sessionId: input.sessionId,
  };
}

export function createContextWindowUsageTracker(
  options: ContextWindowUsageTrackerOptions = {},
): ContextWindowUsageTracker {
  const usages = new Map<string, UiContextWindowUsage>();
  const now = options.now ?? ((): string => new Date().toISOString());

  return {
    clear(): void {
      usages.clear();
    },

    get(sessionId: string): UiContextWindowUsage | null {
      return usages.get(sessionId) ?? null;
    },

    list(): readonly UiContextWindowUsage[] {
      return Array.from(usages.values());
    },

    updateFromContextUsage(
      sessionId: string,
      usage: ContextUsage,
    ): UiContextWindowUsage | null {
      const contextWindowUsage = contextUsageToContextWindowUsage({
        now,
        sessionId,
        usage,
      });
      if (contextWindowUsage) {
        usages.set(sessionId, contextWindowUsage);
      }
      return contextWindowUsage;
    },
  };
}
