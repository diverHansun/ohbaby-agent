import { getMessageOrigin, getReminderAnchorId } from "../message/origin.js";
import type { ModelOrigin } from "../../services/interface-providers/native-state.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";
import { serializeHistoryMessages } from "./serializer.js";
import { hasUnfinishedNativeDependencies } from "./native-context.js";
import { DEFAULT_COMPACTION_THRESHOLDS } from "./constants.js";
import type { CompactionThresholds } from "./constants.js";
import type { MessageWithParts } from "../message/index.js";
import type { ContextUsage, TokenCounter } from "./types.js";

/** Count only the history projection that a normal model request would replay. */
export function estimateHistoryForCompaction(
  history: readonly MessageWithParts[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
  modelOrigin?: ModelOrigin,
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
): number {
  return estimatePreparedRequestHeuristic(
    {
      messages: serializeHistoryMessages(
        history,
        activeReasoningByMessageId,
        modelOrigin,
      ),
      tools: undefined,
    },
    tokenCounter,
  );
}

export function getContextUsage(
  currentTokens: number,
  modelId: string,
  tokenCounter: Pick<TokenCounter, "getLimit" | "getBudget">,
  requestedOutputTokens?: number,
): ContextUsage {
  const budget = tokenCounter.getBudget?.(modelId, {
    usedInputTokens: currentTokens,
    ...(requestedOutputTokens === undefined ? {} : { requestedOutputTokens }),
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

export type CompactionRung = "none" | "summary" | "force";

export function decideCompactionRung(input: {
  readonly usage: ContextUsage;
  readonly capacityPressure?: boolean;
  readonly force: boolean;
  readonly thresholds?: CompactionThresholds;
}): CompactionRung {
  if (input.force) {
    return "force";
  }
  const thresholds = input.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
  if (
    input.capacityPressure === true ||
    needsSummaryCompaction(input.usage, thresholds)
  ) {
    return "summary";
  }
  return "none";
}

export function needsSummaryCompaction(
  usage: ContextUsage,
  thresholds: CompactionThresholds,
): boolean {
  // Auto summary follows the same full-window occupancy shown in the UI.
  const occupancy =
    usage.contextLimit <= 0 ? 1 : usage.currentTokens / usage.contextLimit;
  return occupancy >= thresholds.summary;
}

export interface ContextCutPoint {
  readonly firstKeptIndex: number;
  readonly keptMessages: readonly MessageWithParts[];
}

/**
 * A persisted assistant owns its calls and results; synthetic inputs join their
 * preceding group. Anchored reminders open the group of the assistant they anchor.
 */
export function historyGroups(
  history: readonly MessageWithParts[],
): readonly (readonly MessageWithParts[])[] {
  const groups: MessageWithParts[][] = [];
  let reminderAnchor: string | undefined;
  for (const message of history) {
    const anchor = getReminderAnchorId(message);
    const joinsReminders =
      message.info.role === "assistant" && message.info.id === reminderAnchor;
    if (
      groups.length === 0 ||
      (anchor !== undefined && anchor !== reminderAnchor) ||
      (message.info.role === "assistant" && !joinsReminders) ||
      (message.info.role === "user" && getMessageOrigin(message) === "user")
    )
      groups.push([]);
    groups[groups.length - 1].push(message);
    reminderAnchor = anchor;
  }
  return groups;
}

export function hasUnfinishedDependencies(message: MessageWithParts): boolean {
  return (
    hasUnfinishedNativeDependencies(message) ||
    message.parts.some(
      (part) =>
        part.type === "tool" &&
        (part.state.status === "pending" || part.state.status === "running"),
    )
  );
}

export function findCutPoint(input: {
  readonly history: readonly MessageWithParts[];
  readonly keepRecentTokens: number;
  readonly modelOrigin?: ModelOrigin;
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly tokenCounter: Pick<TokenCounter, "estimateTokens">;
}): ContextCutPoint {
  const { history } = input;
  if (history.length === 0) {
    return {
      firstKeptIndex: 0,
      keptMessages: [],
    };
  }

  const fullTokens = estimateHistoryForCompaction(
    history,
    input.tokenCounter,
    input.modelOrigin,
    input.activeReasoningByMessageId,
  );
  if (fullTokens <= input.keepRecentTokens) {
    return {
      firstKeptIndex: 0,
      keptMessages: history,
    };
  }

  let firstKeptIndex = history.length;
  let keptTokens = 0;
  const groups = historyGroups(history);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimateHistoryForCompaction(
      groups[index],
      input.tokenCounter,
      input.modelOrigin,
      input.activeReasoningByMessageId,
    );
    if (
      firstKeptIndex !== history.length &&
      keptTokens + messageTokens > input.keepRecentTokens
    ) {
      break;
    }
    keptTokens += messageTokens;
    firstKeptIndex -= groups[index].length;
  }
  let groupStart = 0;
  for (const group of groups) {
    if (group.some(hasUnfinishedDependencies))
      firstKeptIndex = Math.min(firstKeptIndex, groupStart);
    groupStart += group.length;
  }

  return {
    firstKeptIndex,
    keptMessages: history.slice(firstKeptIndex),
  };
}
