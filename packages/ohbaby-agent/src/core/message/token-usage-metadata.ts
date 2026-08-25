import type { TokenUsage } from "../llm-client/index.js";
import type { PartMetadata } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function canonicalTokenUsage(value: unknown): TokenUsage | undefined {
  const candidate = record(value);
  if (!candidate) {
    return undefined;
  }
  if (
    !nonNegativeInteger(candidate.inputTokens) ||
    !nonNegativeInteger(candidate.outputTokens)
  ) {
    return undefined;
  }

  const inputTokens = candidate.inputTokens;
  const outputTokens = candidate.outputTokens;
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return undefined;
  }
  const breakdown = record(candidate.inputBreakdown);
  if (!breakdown) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  const observed = record(breakdown.observed);
  if (
    !nonNegativeInteger(breakdown.uncached) ||
    !nonNegativeInteger(breakdown.cacheRead) ||
    !nonNegativeInteger(breakdown.cacheWrite) ||
    breakdown.uncached + breakdown.cacheRead + breakdown.cacheWrite !==
      inputTokens ||
    !observed
  ) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }
  if (
    typeof observed.cacheRead !== "boolean" ||
    typeof observed.cacheWrite !== "boolean"
  ) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
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
    totalTokens,
  };
}

export function createTokenUsageMetadata(
  tokenUsage: TokenUsage | undefined,
): Pick<PartMetadata, "tokenUsage"> | undefined {
  if (tokenUsage === undefined) {
    return undefined;
  }

  return {
    tokenUsage: {
      ...(tokenUsage.inputBreakdown === undefined
        ? {}
        : {
            inputBreakdown: {
              ...tokenUsage.inputBreakdown,
              observed: { ...tokenUsage.inputBreakdown.observed },
            },
          }),
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.inputTokens + tokenUsage.outputTokens,
    },
  };
}

export function readTokenUsageMetadata(
  metadata: unknown,
): TokenUsage | undefined {
  const raw = record(metadata)?.tokenUsage;
  const canonical = canonicalTokenUsage(raw);
  if (canonical) {
    return canonical;
  }
  const legacy = record(raw);
  if (!legacy) {
    return undefined;
  }
  if (
    !nonNegativeInteger(legacy.promptTokens) ||
    !nonNegativeInteger(legacy.completionTokens)
  ) {
    return undefined;
  }
  const totalTokens = legacy.promptTokens + legacy.completionTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return undefined;
  }
  return {
    inputTokens: legacy.promptTokens,
    outputTokens: legacy.completionTokens,
    totalTokens,
  };
}
