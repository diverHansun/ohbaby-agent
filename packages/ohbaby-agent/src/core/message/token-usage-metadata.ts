import type { TokenUsage } from "../llm-client/index.js";
import type { PartMetadata } from "./types.js";

function nonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function canonicalTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !nonNegativeInteger(candidate.inputTokens) ||
    !nonNegativeInteger(candidate.outputTokens)
  ) {
    return undefined;
  }

  const inputTokens = candidate.inputTokens;
  const outputTokens = candidate.outputTokens;
  const rawBreakdown = candidate.inputBreakdown;
  if (typeof rawBreakdown !== "object" || rawBreakdown === null) {
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  const breakdown = rawBreakdown as Record<string, unknown>;
  const rawObserved = breakdown.observed;
  if (
    !nonNegativeInteger(breakdown.uncached) ||
    !nonNegativeInteger(breakdown.cacheRead) ||
    !nonNegativeInteger(breakdown.cacheWrite) ||
    breakdown.uncached + breakdown.cacheRead + breakdown.cacheWrite !==
      inputTokens ||
    typeof rawObserved !== "object" ||
    rawObserved === null
  ) {
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
  const observed = rawObserved as Record<string, unknown>;
  if (
    typeof observed.cacheRead !== "boolean" ||
    typeof observed.cacheWrite !== "boolean"
  ) {
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  return {
    inputBreakdown: {
      cacheRead: breakdown.cacheRead,
      cacheWrite: breakdown.cacheWrite,
      observed: {
        cacheRead: observed.cacheRead,
        cacheWrite: observed.cacheWrite,
      },
      uncached: breakdown.uncached,
    },
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function readTokenUsageMetadata(
  metadata: PartMetadata | undefined,
): TokenUsage | undefined {
  const raw = metadata?.tokenUsage;
  const canonical = canonicalTokenUsage(raw);
  if (canonical) {
    return canonical;
  }
  if (raw === undefined) {
    return undefined;
  }
  const legacy = raw as unknown as Record<string, unknown>;
  if (
    !nonNegativeInteger(legacy.promptTokens) ||
    !nonNegativeInteger(legacy.completionTokens)
  ) {
    return undefined;
  }
  return {
    inputTokens: legacy.promptTokens,
    outputTokens: legacy.completionTokens,
    totalTokens: legacy.promptTokens + legacy.completionTokens,
  };
}
