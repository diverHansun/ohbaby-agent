import type { MessageWithParts, TokenUsageMetadata } from "../message/index.js";
import { serializeHistory, serializeMessage } from "./serialization.js";
import { isSummaryMessage } from "./summary.js";
import type { TokenCounter } from "./types.js";

export interface ContextTokenEstimate {
  readonly tokens: number;
  readonly anchorTokens: number;
  readonly tailTokens: number;
  readonly anchorIndex: number;
}

export function estimateContextTokens(
  history: readonly MessageWithParts[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): ContextTokenEstimate {
  const latestSummaryIndex = findLatestSummaryIndex(history);
  const anchor = findLatestUsageAnchor(history, latestSummaryIndex);
  if (!anchor) {
    const tokens = tokenCounter.estimateTokens(serializeHistory(history));
    return { tokens, anchorTokens: 0, tailTokens: tokens, anchorIndex: -1 };
  }

  const tailTokens = history
    .slice(anchor.index + 1)
    .reduce(
      (sum, message) =>
        sum + tokenCounter.estimateTokens(serializeMessage(message)),
      0,
    );
  return {
    tokens: anchor.tokens + tailTokens,
    anchorTokens: anchor.tokens,
    tailTokens,
    anchorIndex: anchor.index,
  };
}

function findLatestUsageAnchor(
  history: readonly MessageWithParts[],
  latestSummaryIndex: number,
): { readonly index: number; readonly tokens: number } | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (index < latestSummaryIndex) {
      continue;
    }

    const usage = message.parts
      .map((part) => readTokenUsage(part.metadata))
      .find(
        (candidate): candidate is TokenUsageMetadata =>
          candidate !== undefined,
      );
    if (usage) {
      return { index, tokens: usage.totalTokens };
    }
  }
  return undefined;
}

function findLatestSummaryIndex(
  history: readonly MessageWithParts[],
): number {
  let latest = -1;
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (isSummaryMessage(message)) {
      latest = index;
    }
  }
  return latest;
}

function readTokenUsage(
  metadata: { readonly tokenUsage?: unknown } | undefined,
): TokenUsageMetadata | undefined {
  const tokenUsage = metadata?.tokenUsage;
  if (tokenUsage === undefined || tokenUsage === null) {
    return undefined;
  }
  if (typeof tokenUsage !== "object") {
    return undefined;
  }
  const record = tokenUsage as Record<string, unknown>;
  if (
    typeof record.promptTokens !== "number" ||
    typeof record.completionTokens !== "number" ||
    typeof record.totalTokens !== "number"
  ) {
    return undefined;
  }
  return {
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
  };
}
