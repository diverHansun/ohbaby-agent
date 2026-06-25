import type { MessageWithParts } from "../message/index.js";
import { getMessageOrigin } from "../message/index.js";

export function isSummaryMessage(message: MessageWithParts): boolean {
  return getMessageOrigin(message) === "summary";
}

export function getSummaryMessages(
  history: readonly MessageWithParts[],
): readonly MessageWithParts[] {
  return history.filter(isSummaryMessage);
}

export function partitionSummary(history: readonly MessageWithParts[]): {
  readonly summaries: readonly MessageWithParts[];
  readonly nonSummary: readonly MessageWithParts[];
} {
  return {
    summaries: getSummaryMessages(history),
    nonSummary: history.filter((message) => !isSummaryMessage(message)),
  };
}
