import type {
  InputTokenBreakdown,
  InterfaceProviderTokenUsage,
} from "./types.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface AnthropicUsageAccumulator {
  update(usage: unknown): InterfaceProviderTokenUsage | undefined;
}

export interface TokenUsageNormalizationDiagnostic {
  readonly type: "llm.usage.normalization";
  readonly code:
    | "input-breakdown-conflict"
    | "non-monotonic-cumulative-field"
    | "raw-total-mismatch";
  readonly protocol: "anthropic" | "openai-compatible";
  readonly field?:
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
    | "input_tokens"
    | "output_tokens";
  readonly received?: number;
  readonly retained?: number;
  readonly normalizedTotal?: number;
}

export type TokenUsageDiagnosticReporter = (
  diagnostic: TokenUsageNormalizationDiagnostic,
) => void;

function ignoreTokenUsageDiagnostic(
  _diagnostic: TokenUsageNormalizationDiagnostic,
): void {
  return;
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function field(
  input: UnknownRecord | undefined,
  key: string,
): number | undefined {
  return nonNegativeInteger(input?.[key]);
}

function breakdown(input: {
  readonly inputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheReadObserved: boolean;
  readonly cacheWriteObserved: boolean;
  readonly uncached?: number;
}): InputTokenBreakdown | undefined {
  const uncached =
    input.uncached ?? input.inputTokens - input.cacheRead - input.cacheWrite;
  if (
    !Number.isFinite(input.inputTokens) ||
    !Number.isInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isFinite(input.cacheRead) ||
    !Number.isInteger(input.cacheRead) ||
    input.cacheRead < 0 ||
    !Number.isFinite(input.cacheWrite) ||
    !Number.isInteger(input.cacheWrite) ||
    input.cacheWrite < 0 ||
    !Number.isFinite(uncached) ||
    !Number.isInteger(uncached) ||
    uncached < 0 ||
    uncached + input.cacheRead + input.cacheWrite !== input.inputTokens
  ) {
    return undefined;
  }

  return {
    cacheRead: input.cacheRead,
    cacheWrite: input.cacheWrite,
    observed: {
      cacheRead: input.cacheReadObserved,
      cacheWrite: input.cacheWriteObserved,
    },
    uncached,
  };
}

function tokenUsage(input: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputBreakdown?: InputTokenBreakdown;
}): InterfaceProviderTokenUsage {
  return {
    ...(input.inputBreakdown === undefined
      ? {}
      : { inputBreakdown: input.inputBreakdown }),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.inputTokens + input.outputTokens,
  };
}

function openAICompatibleTokenUsage(
  input: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly inputBreakdown?: InputTokenBreakdown;
  },
  rawTotal: number | undefined,
  report: TokenUsageDiagnosticReporter,
): InterfaceProviderTokenUsage {
  const normalized = tokenUsage(input);
  if (rawTotal !== undefined && rawTotal !== normalized.totalTokens) {
    report({
      code: "raw-total-mismatch",
      normalizedTotal: normalized.totalTokens,
      protocol: "openai-compatible",
      received: rawTotal,
      type: "llm.usage.normalization",
    });
  }
  return normalized;
}

function reportBreakdownConflict(report: TokenUsageDiagnosticReporter): void {
  report({
    code: "input-breakdown-conflict",
    protocol: "openai-compatible",
    type: "llm.usage.normalization",
  });
}

export function normalizeOpenAICompatibleUsage(
  rawUsage: unknown,
  report: TokenUsageDiagnosticReporter = ignoreTokenUsageDiagnostic,
): InterfaceProviderTokenUsage | undefined {
  const usage = record(rawUsage);
  if (!usage) {
    return undefined;
  }

  const outputTokens = field(usage, "completion_tokens");
  const promptTokens = field(usage, "prompt_tokens");
  const cacheHit = field(usage, "prompt_cache_hit_tokens");
  const cacheMiss = field(usage, "prompt_cache_miss_tokens");
  const rawTotal = field(usage, "total_tokens");
  if (outputTokens === undefined) {
    return undefined;
  }

  if (cacheHit !== undefined || cacheMiss !== undefined) {
    if (
      promptTokens === undefined &&
      (cacheHit === undefined || cacheMiss === undefined)
    ) {
      return undefined;
    }
    const inputTokens = promptTokens ?? (cacheHit ?? 0) + (cacheMiss ?? 0);
    const resolvedRead = cacheHit ?? inputTokens - (cacheMiss ?? 0);
    const resolvedMiss = cacheMiss ?? inputTokens - resolvedRead;
    const inputBreakdown = breakdown({
      cacheRead: resolvedRead,
      cacheReadObserved: cacheHit !== undefined,
      cacheWrite: 0,
      cacheWriteObserved: false,
      inputTokens,
      uncached: resolvedMiss,
    });
    if (inputBreakdown === undefined) {
      reportBreakdownConflict(report);
    }
    return openAICompatibleTokenUsage(
      {
        ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
        inputTokens,
        outputTokens,
      },
      rawTotal,
      report,
    );
  }

  if (promptTokens === undefined) {
    return undefined;
  }

  const details = record(usage.prompt_tokens_details);
  const nestedRead = field(details, "cached_tokens");
  const nestedWrite = field(details, "cache_write_tokens");
  if (nestedRead !== undefined || nestedWrite !== undefined) {
    const inputBreakdown = breakdown({
      cacheRead: nestedRead ?? 0,
      cacheReadObserved: nestedRead !== undefined,
      cacheWrite: nestedWrite ?? 0,
      cacheWriteObserved: nestedWrite !== undefined,
      inputTokens: promptTokens,
    });
    if (inputBreakdown === undefined) {
      reportBreakdownConflict(report);
    }
    return openAICompatibleTokenUsage(
      {
        ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
        inputTokens: promptTokens,
        outputTokens,
      },
      rawTotal,
      report,
    );
  }

  const topLevelRead = field(usage, "cached_tokens");
  if (topLevelRead !== undefined) {
    const inputBreakdown = breakdown({
      cacheRead: topLevelRead,
      cacheReadObserved: true,
      cacheWrite: 0,
      cacheWriteObserved: false,
      inputTokens: promptTokens,
    });
    if (inputBreakdown === undefined) {
      reportBreakdownConflict(report);
    }
    return openAICompatibleTokenUsage(
      {
        ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
        inputTokens: promptTokens,
        outputTokens,
      },
      rawTotal,
      report,
    );
  }

  return openAICompatibleTokenUsage(
    { inputTokens: promptTokens, outputTokens },
    rawTotal,
    report,
  );
}

function monotonic(current: number | undefined, incoming: number): number {
  return current === undefined ? incoming : Math.max(current, incoming);
}

export function createAnthropicUsageAccumulator(
  report: TokenUsageDiagnosticReporter = ignoreTokenUsageDiagnostic,
): AnthropicUsageAccumulator {
  let uncached: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadObserved = false;
  let cacheWriteObserved = false;

  return {
    update(rawUsage): InterfaceProviderTokenUsage | undefined {
      const usage = record(rawUsage);
      if (!usage) {
        return undefined;
      }

      const nextUncached = field(usage, "input_tokens");
      const nextCacheRead = field(usage, "cache_read_input_tokens");
      const nextCacheWrite = field(usage, "cache_creation_input_tokens");
      const nextOutput = field(usage, "output_tokens");

      for (const [name, current, incoming] of [
        ["input_tokens", uncached, nextUncached],
        ["cache_read_input_tokens", cacheRead, nextCacheRead],
        ["cache_creation_input_tokens", cacheWrite, nextCacheWrite],
        ["output_tokens", outputTokens, nextOutput],
      ] as const) {
        if (
          current !== undefined &&
          incoming !== undefined &&
          incoming < current
        ) {
          report({
            code: "non-monotonic-cumulative-field",
            field: name,
            protocol: "anthropic",
            received: incoming,
            retained: current,
            type: "llm.usage.normalization",
          });
        }
      }

      if (nextUncached !== undefined) {
        uncached = monotonic(uncached, nextUncached);
      }
      if (nextCacheRead !== undefined) {
        cacheReadObserved = true;
        cacheRead = monotonic(cacheRead, nextCacheRead);
      }
      if (nextCacheWrite !== undefined) {
        cacheWriteObserved = true;
        cacheWrite = monotonic(cacheWrite, nextCacheWrite);
      }
      if (nextOutput !== undefined) {
        outputTokens = monotonic(outputTokens, nextOutput);
      }

      if (
        outputTokens === undefined ||
        (uncached === undefined &&
          cacheRead === undefined &&
          cacheWrite === undefined)
      ) {
        return undefined;
      }

      const resolvedUncached = uncached ?? 0;
      const resolvedRead = cacheRead ?? 0;
      const resolvedWrite = cacheWrite ?? 0;
      const inputTokens = resolvedUncached + resolvedRead + resolvedWrite;
      const inputBreakdown =
        cacheReadObserved || cacheWriteObserved
          ? breakdown({
              cacheRead: resolvedRead,
              cacheReadObserved,
              cacheWrite: resolvedWrite,
              cacheWriteObserved,
              inputTokens,
              uncached: resolvedUncached,
            })
          : undefined;

      return tokenUsage({
        ...(inputBreakdown === undefined ? {} : { inputBreakdown }),
        inputTokens,
        outputTokens,
      });
    },
  };
}
