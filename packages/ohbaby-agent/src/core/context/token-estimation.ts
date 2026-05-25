import type { MessageWithParts, TokenUsageMetadata } from "../message/index.js";
import { serializeHistory, serializeMessage } from "./serialization.js";
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
  const anchor = findLatestUsageAnchor(history);
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
): { readonly index: number; readonly tokens: number } | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const usage = history[index]?.parts
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

function readTokenUsage(metadata: unknown): TokenUsageMetadata | undefined {
  if (metadata === null || typeof metadata !== "object") {
    return undefined;
  }
  const tokenUsage = (metadata as Record<string, unknown>).tokenUsage;
  if (tokenUsage === null || typeof tokenUsage !== "object") {
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
