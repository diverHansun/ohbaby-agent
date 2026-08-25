import {
  DEFAULT_COMPACTION_THRESHOLDS,
  KEEP_RECENT_TOKENS,
} from "./constants.js";
import type { CompactionThresholds } from "./constants.js";
import { serializeHistory, serializeMessage } from "./serialization.js";
import type { MessageWithParts } from "../message/index.js";
import type { ContextUsage, TokenCounter } from "./types.js";

function tokenCount(
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
  content: string,
): number {
  return Math.max(0, tokenCounter.estimateTokens(content));
}

export function getContextUsage(
  currentTokens: number,
  modelId: string,
  tokenCounter: Pick<TokenCounter, "getLimit" | "getBudget">,
): ContextUsage {
  const budget = tokenCounter.getBudget?.(modelId, {
    usedInputTokens: currentTokens,
  });

  if (budget) {
    return {
      contextLimit: budget.contextWindowTokens,
      currentTokens,
      inputBudgetTokens: budget.inputBudgetTokens,
      modelId,
      remainingTokens: budget.remainingInputTokens,
      reservedOutputTokens: budget.reservedOutputTokens,
      safetyMarginTokens: budget.safetyMarginTokens,
      usageRatio: budget.usageRatio,
    };
  }

  const contextLimit = tokenCounter.getLimit(modelId);
  const usageRatio = contextLimit === 0 ? 1 : currentTokens / contextLimit;

  return {
    currentTokens,
    contextLimit,
    modelId,
    remainingTokens: Math.max(0, contextLimit - currentTokens),
    usageRatio,
  };
}

export type CompactionRung = "none" | "mask" | "prune-summary" | "force";

export function decideCompactionRung(input: {
  readonly usage: ContextUsage;
  readonly compactionCount?: number;
  readonly force: boolean;
  readonly maxPerTurn?: number;
  readonly thresholds?: CompactionThresholds;
  readonly thrashLocked?: boolean;
}): CompactionRung {
  if (input.force) {
    return "force";
  }
  if (input.thrashLocked === true) {
    return "none";
  }
  const thresholds = input.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
  if (needsSummaryCompaction(input.usage, thresholds)) {
    if (
      (input.compactionCount ?? 0) >=
      (input.maxPerTurn ?? Number.POSITIVE_INFINITY)
    ) {
      return "mask";
    }
    return "prune-summary";
  }
  if (input.usage.usageRatio >= thresholds.mask) {
    return "mask";
  }
  return "none";
}

export function needsSummaryCompaction(
  usage: ContextUsage,
  thresholds: CompactionThresholds,
): boolean {
  return (
    usage.usageRatio >= thresholds.summary ||
    usage.remainingTokens < thresholds.minRemainingInputTokens
  );
}

export interface ContextCutPoint {
  readonly firstKeptIndex: number;
  readonly messagesToSummarize: readonly MessageWithParts[];
  readonly keptMessages: readonly MessageWithParts[];
  readonly turnPrefixMessages: readonly MessageWithParts[];
}

export function findCutPoint(input: {
  readonly history: readonly MessageWithParts[];
  readonly keepRecentTokens: number;
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
}): ContextCutPoint {
  const { history } = input;
  if (history.length === 0) {
    return {
      firstKeptIndex: 0,
      keptMessages: [],
      messagesToSummarize: [],
      turnPrefixMessages: [],
    };
  }

  const fullTokens = tokenCount(input.tokenCounter, serializeHistory(history));
  if (fullTokens <= input.keepRecentTokens) {
    return {
      firstKeptIndex: 0,
      keptMessages: history,
      messagesToSummarize: [],
      turnPrefixMessages: [],
    };
  }

  let firstKeptIndex = history.length;
  let keptTokens = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const messageTokens = tokenCount(
      input.tokenCounter,
      serializeMessage(history[index]),
    );
    if (
      firstKeptIndex !== history.length &&
      keptTokens + messageTokens > input.keepRecentTokens
    ) {
      break;
    }
    keptTokens += messageTokens;
    firstKeptIndex = index;
  }

  const legalCutPoints = new Set<number>([0, history.length]);
  for (let index = 0; index < history.length; index += 1) {
    const role = history[index]?.info.role;
    if (role === "user" || role === "assistant") {
      legalCutPoints.add(index);
    }
  }

  while (
    firstKeptIndex < history.length &&
    !legalCutPoints.has(firstKeptIndex)
  ) {
    firstKeptIndex += 1;
  }

  const turnPrefixMessages =
    firstKeptIndex > 0 &&
    history[firstKeptIndex]?.info.role === "assistant" &&
    history[firstKeptIndex - 1]?.info.role === "user"
      ? [history[firstKeptIndex - 1]]
      : [];
  const messagesToSummarizeEnd = firstKeptIndex - turnPrefixMessages.length;

  return {
    firstKeptIndex,
    keptMessages: history.slice(firstKeptIndex),
    messagesToSummarize: history.slice(0, messagesToSummarizeEnd),
    turnPrefixMessages,
  };
}

export function getHistoryToCompress(input: {
  readonly history: readonly MessageWithParts[];
  readonly preserveRatio: number;
  readonly tokenCounter: TokenCounter;
}): readonly MessageWithParts[] {
  const fullTokens = tokenCount(
    input.tokenCounter,
    serializeHistory(input.history),
  );
  const preserveTarget = Math.max(
    1,
    Math.floor(fullTokens * input.preserveRatio),
  );
  const cut = findCutPoint({
    history: input.history,
    keepRecentTokens:
      fullTokens <= KEEP_RECENT_TOKENS ? preserveTarget : KEEP_RECENT_TOKENS,
    tokenCounter: input.tokenCounter,
  });

  return [...cut.messagesToSummarize, ...cut.turnPrefixMessages];
}
