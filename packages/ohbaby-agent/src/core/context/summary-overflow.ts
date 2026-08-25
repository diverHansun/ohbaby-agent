import type { MessageWithParts } from "../message/index.js";
import { serializeHistory } from "./serialization.js";
import type { TokenCounter } from "./types.js";

export interface SummaryHistoryShrink {
  readonly droppedRounds: number;
  readonly history: readonly MessageWithParts[];
  readonly inputTokens: number;
}

function summaryInputTokens(
  history: readonly MessageWithParts[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  return Math.max(
    0,
    tokenCounter.estimateTokens(
      serializeHistory(history, { includeModelContext: false }),
    ),
  );
}

function nextUserBoundary(
  history: readonly MessageWithParts[],
): number | undefined {
  let seenUser = false;
  for (const [index, message] of history.entries()) {
    if (message.info.role !== "user") {
      continue;
    }
    if (seenUser) {
      return index;
    }
    seenUser = true;
  }
  return undefined;
}

/**
 * Drops one or more complete oldest user rounds until the provider-visible
 * summary input strictly shrinks. The returned history always starts at a
 * user boundary, so assistant tool calls and their projected results remain
 * paired. At least the most recent user round is retained.
 */
export function shrinkSummaryHistory(input: {
  readonly history: readonly MessageWithParts[];
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
}): SummaryHistoryShrink | undefined {
  const initialTokens = summaryInputTokens(input.history, input.tokenCounter);
  let candidate = input.history;
  let droppedRounds = 0;
  let boundary = nextUserBoundary(candidate);

  while (boundary !== undefined) {
    candidate = candidate.slice(boundary);
    droppedRounds += 1;
    const inputTokens = summaryInputTokens(candidate, input.tokenCounter);
    if (inputTokens < initialTokens) {
      return {
        droppedRounds,
        history: candidate,
        inputTokens,
      };
    }
    boundary = nextUserBoundary(candidate);
  }

  return undefined;
}
