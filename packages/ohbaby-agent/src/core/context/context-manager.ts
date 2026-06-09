import {
  COMPACTION_RESERVE_TOKENS,
  COMPRESSION_PRESERVE_RATIO,
  COMPRESSION_THRESHOLD,
  KEEP_RECENT_TOKENS,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
import {
  AGGRESSIVE_COMPRESSION_PROMPT,
  COMPRESSION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./compression-prompt.js";
import { ContextEvent } from "./events.js";
import { appendFileOpsSummary, extractFileOps } from "./file-ops.js";
import { isActivePart } from "./filters.js";
import {
  getCompletedToolOutput,
  serializeHistory,
  serializeMessage,
} from "./serialization.js";
import { serializeForLlm } from "./serializer.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import { estimateContextTokens } from "./token-estimation.js";
import type {
  AssembledContext,
  CompactOptions,
  CompactResult,
  CompactStatus,
  CompressionResult,
  ContextManager,
  ContextManagerOptions,
  ContextUsage,
  PreparedTurn,
  PrepareTurnInput,
  PruneResult,
  TokenCounter,
} from "./types.js";
import type { MessageWithParts, Part, PartMetadata } from "../message/index.js";
import type { MergedMemory } from "../memory/index.js";

const EMPTY_MEMORY: MergedMemory = { global: "", project: "", merged: "" };

type SummaryCandidate =
  | CompressionResult
  | {
      readonly status: "candidate";
      readonly historyToCompress: readonly MessageWithParts[];
      readonly newTokens: number;
      readonly originalTokens: number;
      readonly savedTokens: number;
      readonly snapshot: string;
    };

type CommittableSummaryCandidate = Extract<
  SummaryCandidate,
  { readonly status: "candidate" }
>;

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenCount(
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
  content: string,
): number {
  return Math.max(0, tokenCounter.estimateTokens(content));
}

export function getContextUsage(
  context: Pick<AssembledContext, "estimatedTokens">,
  modelId: string,
  tokenCounter: Pick<TokenCounter, "getLimit" | "getBudget">,
  compressionThreshold = COMPRESSION_THRESHOLD,
): ContextUsage {
  const currentTokens = context.estimatedTokens;
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
      shouldCompress: budget.remainingInputTokens < COMPACTION_RESERVE_TOKENS,
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
    shouldCompress: usageRatio >= compressionThreshold,
    usageRatio,
  };
}

export type CompactAction = "skip" | "prune-only" | "compact";

export function decideCompactAction(input: {
  readonly usage: ContextUsage;
  readonly historyLength: number;
  readonly force: boolean;
}): CompactAction {
  if (input.force) {
    return "compact";
  }
  if (!input.usage.shouldCompress) {
    return "skip";
  }
  if (input.historyLength <= 2) {
    return "prune-only";
  }
  return "compact";
}

function skippedReasonForCompression(
  compression: CompressionResult,
): "inflated" | "too-short" | undefined {
  if (compression.status === "inflated") {
    return "inflated";
  }
  if (compression.status === "skipped") {
    return "too-short";
  }
  return undefined;
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

function getHistoryToCompress(input: {
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

function getActiveHistory(
  history: readonly MessageWithParts[],
): MessageWithParts[] {
  const active = history.flatMap((message) => {
    const parts = message.parts.filter(isActivePart);
    if (parts.length === 0) {
      return [];
    }

    return [{ info: message.info, parts }];
  });

  const { summaries, nonSummary } = partitionSummary(active);
  if (summaries.length === 0) {
    return active;
  }

  return [...summaries, ...nonSummary];
}

function markCompactedParts(
  history: readonly MessageWithParts[],
  compactedPartIds: ReadonlySet<string>,
  compactedAt: number | undefined,
): readonly MessageWithParts[] {
  if (compactedPartIds.size === 0 || compactedAt === undefined) {
    return history;
  }

  return history.map((message) => ({
    info: message.info,
    parts: message.parts.map((part) => {
      if (compactedPartIds.has(part.id)) {
        return { ...part, time: { ...part.time, compacted: compactedAt } };
      }
      const metadata = removeTokenUsageMetadata(part.metadata);
      return metadata === undefined ? part : { ...part, metadata };
    }),
  }));
}

function compactedPartIdsFromHistory(
  history: readonly MessageWithParts[],
): ReadonlySet<string> {
  return new Set(
    history.flatMap((message) => message.parts.map((part) => part.id)),
  );
}

function removeTokenUsageMetadata(
  metadata: PartMetadata | undefined,
): PartMetadata | undefined {
  if (metadata?.tokenUsage === undefined) {
    return undefined;
  }
  const { tokenUsage: _tokenUsage, ...retained } = metadata;
  return retained;
}

export function createContextManager(
  options: ContextManagerOptions,
): ContextManager {
  const now = options.now ?? Date.now;
  const compressionThreshold =
    options.compressionThreshold ?? COMPRESSION_THRESHOLD;
  const compressionPreserveRatio =
    options.compressionPreserveRatio ?? COMPRESSION_PRESERVE_RATIO;
  const pruneProtectTokens = options.pruneProtectTokens ?? PRUNE_PROTECT_TOKENS;
  const pruneMinimumTokens = options.pruneMinimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const summaryAgentName = options.summaryAgentName ?? SUMMARY_AGENT_NAME;

  function estimateAssembledTokens(
    systemPrompt: string,
    memory: MergedMemory,
    history: readonly MessageWithParts[],
  ): number {
    return (
      tokenCount(
        options.tokenCounter,
        [systemPrompt, memory.merged].filter(Boolean).join("\n\n"),
      ) + estimateContextTokens(history, options.tokenCounter).tokens
    );
  }

  function assembleFromRawHistory(input: {
    readonly assembledAt: number;
    readonly memory: MergedMemory;
    readonly rawHistory: readonly MessageWithParts[];
    readonly sessionId: string;
    readonly systemPrompt: string;
  }): AssembledContext {
    const history = getActiveHistory(input.rawHistory);

    return {
      systemPrompt: input.systemPrompt,
      memory: input.memory,
      history,
      estimatedTokens: estimateAssembledTokens(
        input.systemPrompt,
        input.memory,
        history,
      ),
      hasSummary: input.rawHistory.some(isSummaryMessage),
      assembledAt: input.assembledAt,
      sessionId: input.sessionId,
    };
  }

  async function assemble(
    sessionId: string,
    directory: string,
    isSubagent = false,
  ): Promise<AssembledContext> {
    let memory = EMPTY_MEMORY;
    if (!isSubagent) {
      try {
        memory = await options.memory.load(directory);
      } catch (error) {
        options.onWarning?.("Unable to load memory for context", error);
      }
    }

    const [systemPrompt, rawHistory] = await Promise.all([
      options.systemPromptProvider.build({ sessionId, directory, isSubagent }),
      options.messageManager.listBySession(sessionId),
    ]);
    return assembleFromRawHistory({
      assembledAt: now(),
      memory,
      rawHistory,
      sessionId,
      systemPrompt,
    });
  }

  async function pruneHistory(
    sessionId: string,
    history: readonly MessageWithParts[],
  ): Promise<{
    readonly compactedAt?: number;
    readonly compactedPartIds: ReadonlySet<string>;
    readonly result: PruneResult;
  }> {
    const candidates: { readonly part: Part; readonly tokens: number }[] = [];

    for (const message of history) {
      for (const part of message.parts) {
        const output = getCompletedToolOutput(part);
        if (output !== undefined) {
          candidates.push({
            part,
            tokens: tokenCount(options.tokenCounter, output),
          });
        }
      }
    }

    let protectedTokens = 0;
    let protectedCount = 0;
    const prunable: { readonly part: Part; readonly tokens: number }[] = [];

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (protectedTokens < pruneProtectTokens) {
        protectedTokens += candidate.tokens;
        protectedCount += 1;
      } else {
        prunable.push(candidate);
      }
    }

    const freedTokens = prunable.reduce(
      (sum, candidate) => sum + candidate.tokens,
      0,
    );
    if (freedTokens < pruneMinimumTokens) {
      const result = {
        prunedCount: 0,
        freedTokens: 0,
        protectedCount,
        totalScanned: candidates.length,
      };
      options.bus.publish(ContextEvent.Pruned, { sessionId, result });
      return { compactedPartIds: new Set(), result };
    }

    const compactedAt = now();
    const compactedPartIds = new Set<string>();
    for (const candidate of prunable) {
      await options.messageManager.updatePart(candidate.part.id, {
        time: { ...candidate.part.time, compacted: compactedAt },
      });
      compactedPartIds.add(candidate.part.id);
    }
    await clearRetainedTokenUsageMetadata(history, compactedPartIds);

    const result = {
      prunedCount: prunable.length,
      freedTokens,
      protectedCount,
      totalScanned: candidates.length,
    };
    options.bus.publish(ContextEvent.Pruned, { sessionId, result });
    return { compactedAt, compactedPartIds, result };
  }

  async function prune(sessionId: string): Promise<PruneResult> {
    const history = await options.messageManager.listBySession(sessionId);
    const { result } = await pruneHistory(sessionId, history);
    return result;
  }

  async function clearRetainedTokenUsageMetadata(
    history: readonly MessageWithParts[],
    compactedPartIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const message of history) {
      for (const part of message.parts) {
        if (compactedPartIds.has(part.id)) {
          continue;
        }
        const metadata = removeTokenUsageMetadata(part.metadata);
        if (metadata !== undefined) {
          await options.messageManager.updatePart(part.id, { metadata });
        }
      }
    }
  }

  async function generateSummaryCandidate(
    sessionId: string,
    rawHistory: readonly MessageWithParts[],
  ): Promise<SummaryCandidate> {
    const activeHistory = getActiveHistory(rawHistory).filter(
      (message) => !isSummaryMessage(message),
    );
    const activeTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(activeHistory),
    );
    if (activeHistory.length <= 2) {
      return {
        status: "skipped",
        originalTokens: activeTokens,
        newTokens: activeTokens,
        savedTokens: 0,
      };
    }

    const historyToCompress = getHistoryToCompress({
      history: activeHistory,
      preserveRatio: compressionPreserveRatio,
      tokenCounter: options.tokenCounter,
    });
    const originalTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(historyToCompress),
    );
    if (historyToCompress.length === 0 || originalTokens === 0) {
      return {
        status: "skipped",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
      };
    }

    let snapshot = "";
    let newTokens = originalTokens;
    const prompts = [COMPRESSION_PROMPT, AGGRESSIVE_COMPRESSION_PROMPT];
    for (const prompt of prompts) {
      try {
        snapshot = await options.llmClient.generateSummary({
          sessionId,
          prompt,
          systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
          history: historyToCompress,
        });
      } catch (error) {
        return {
          status: "failed",
          originalTokens,
          newTokens: originalTokens,
          savedTokens: 0,
          error: errorToMessage(error),
        };
      }
      snapshot = appendFileOpsSummary(
        snapshot,
        extractFileOps(historyToCompress),
      );

      newTokens = tokenCount(options.tokenCounter, snapshot);
      if (newTokens < originalTokens) {
        break;
      }
    }

    if (newTokens >= originalTokens) {
      return {
        status: "inflated",
        originalTokens,
        newTokens,
        savedTokens: 0,
      };
    }

    return {
      status: "candidate",
      historyToCompress,
      originalTokens,
      newTokens,
      savedTokens: originalTokens - newTokens,
      snapshot,
    };
  }

  async function commitSummaryCandidate(
    sessionId: string,
    rawHistory: readonly MessageWithParts[],
    candidate: CommittableSummaryCandidate,
  ): Promise<CompressionResult> {
    const summary = await options.messageManager.createMessage({
      sessionId,
      role: "assistant",
      agent: summaryAgentName,
    });
    await options.messageManager.appendPart(summary.id, {
      type: "text",
      text: candidate.snapshot,
      synthetic: true,
      metadata: { kind: "context-summary" },
    });
    const compactedAt = now();
    const compactedPartIds = new Set<string>();
    for (const message of candidate.historyToCompress) {
      for (const part of message.parts) {
        compactedPartIds.add(part.id);
        if (part.time?.compacted === undefined) {
          await options.messageManager.updatePart(part.id, {
            time: { ...part.time, compacted: compactedAt },
          });
        }
      }
    }
    for (const message of rawHistory) {
      for (const part of message.parts) {
        if (compactedPartIds.has(part.id)) {
          continue;
        }
        const metadata = removeTokenUsageMetadata(part.metadata);
        if (metadata !== undefined) {
          await options.messageManager.updatePart(part.id, { metadata });
        }
      }
    }

    const result = {
      status: "compressed",
      originalTokens: candidate.originalTokens,
      newTokens: candidate.newTokens,
      savedTokens: candidate.savedTokens,
      summaryMessageId: summary.id,
    } satisfies CompressionResult;
    options.bus.publish(ContextEvent.Compressed, { sessionId, result });
    return result;
  }

  function projectSummaryCandidate(input: {
    readonly assembled: AssembledContext;
    readonly candidate: CommittableSummaryCandidate;
    readonly compactedAt: number;
  }): AssembledContext {
    const compactedPartIds = compactedPartIdsFromHistory(
      input.candidate.historyToCompress,
    );
    const projectedHistory = [
      ...markCompactedParts(
        input.assembled.history,
        compactedPartIds,
        input.compactedAt,
      ),
      {
        info: {
          agent: summaryAgentName,
          id: `projected_summary_${String(input.compactedAt)}`,
          role: "assistant" as const,
          sessionId: input.assembled.sessionId,
          time: { created: input.compactedAt },
        },
        parts: [
          {
            id: `projected_summary_part_${String(input.compactedAt)}`,
            messageId: `projected_summary_${String(input.compactedAt)}`,
            metadata: { kind: "context-summary" },
            orderIndex: 0,
            sessionId: input.assembled.sessionId,
            synthetic: true,
            text: input.candidate.snapshot,
            type: "text" as const,
          },
        ],
      },
    ];

    return assembleFromRawHistory({
      assembledAt: input.assembled.assembledAt,
      memory: input.assembled.memory,
      rawHistory: projectedHistory,
      sessionId: input.assembled.sessionId,
      systemPrompt: input.assembled.systemPrompt,
    });
  }

  function compressionFromRejectedCandidate(
    candidate: CommittableSummaryCandidate,
  ): CompressionResult {
    return {
      status: "inflated",
      originalTokens: candidate.originalTokens,
      newTokens: candidate.newTokens,
      savedTokens: 0,
    };
  }

  function pruneReducedContext(input: {
    readonly pruneResult: PruneResult;
    readonly usageBefore: ContextUsage;
    readonly usageAfterPrune: ContextUsage;
  }): boolean {
    return (
      input.pruneResult.prunedCount > 0 &&
      input.usageAfterPrune.currentTokens < input.usageBefore.currentTokens
    );
  }

  function statusForUncommittedCompression(input: {
    readonly compression: CompressionResult;
    readonly pruneResult: PruneResult;
    readonly usageBefore: ContextUsage;
    readonly usageAfterPrune: ContextUsage;
  }): CompactStatus {
    if (input.compression.status === "failed") {
      return "failed";
    }
    if (
      pruneReducedContext({
        pruneResult: input.pruneResult,
        usageBefore: input.usageBefore,
        usageAfterPrune: input.usageAfterPrune,
      })
    ) {
      return "pruned";
    }
    if (input.compression.status === "inflated") {
      return "inflated";
    }
    return "not-needed";
  }

  function publishCompactSkippedForCompression(input: {
    readonly compression: CompressionResult;
    readonly sessionId: string;
    readonly usage: ContextUsage;
  }): void {
    const skippedReason = skippedReasonForCompression(input.compression);
    if (skippedReason !== undefined) {
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId: input.sessionId,
        reason: skippedReason,
        usage: input.usage,
      });
    }
  }

  async function compress(
    sessionId: string,
    force = false,
    modelId = "default",
  ): Promise<CompressionResult> {
    const historyBeforePrune =
      await options.messageManager.listBySession(sessionId);
    const fullTokens = tokenCount(
      options.tokenCounter,
      serializeHistory(historyBeforePrune),
    );
    const usage = getContextUsage(
      { estimatedTokens: fullTokens },
      modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (!force && !usage.shouldCompress) {
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId,
        reason: "not-needed",
        usage,
      });
      return {
        status: "skipped",
        originalTokens: fullTokens,
        newTokens: fullTokens,
        savedTokens: 0,
      };
    }

    const pruneResult = await prune(sessionId);
    const historyAfterPrune =
      await options.messageManager.listBySession(sessionId);
    const contextAfterPrune = assembleFromRawHistory({
      assembledAt: 0,
      memory: EMPTY_MEMORY,
      rawHistory: historyAfterPrune,
      sessionId,
      systemPrompt: "",
    });
    const usageAfterPrune = getContextUsage(
      contextAfterPrune,
      modelId,
      options.tokenCounter,
      compressionThreshold,
    );
    const candidate = await generateSummaryCandidate(
      sessionId,
      contextAfterPrune.history,
    );
    if (candidate.status !== "candidate") {
      publishCompactSkippedForCompression({
        compression: candidate,
        sessionId,
        usage: usageAfterPrune,
      });
      return candidate;
    }

    const projectedContext = projectSummaryCandidate({
      assembled: contextAfterPrune,
      candidate,
      compactedAt: contextAfterPrune.assembledAt,
    });
    const projectedUsage = getContextUsage(
      projectedContext,
      modelId,
      options.tokenCounter,
      compressionThreshold,
    );
    if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
      const rejected = compressionFromRejectedCandidate(candidate);
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId,
        reason: "inflated",
        usage: usageAfterPrune,
      });
      return pruneReducedContext({
        pruneResult,
        usageBefore: usage,
        usageAfterPrune,
      })
        ? {
            status: "skipped",
            originalTokens: usage.currentTokens,
            newTokens: usageAfterPrune.currentTokens,
            savedTokens: Math.max(
              0,
              usage.currentTokens - usageAfterPrune.currentTokens,
            ),
          }
        : rejected;
    }

    return commitSummaryCandidate(sessionId, historyAfterPrune, candidate);
  }

  async function compact(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    const before = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageBefore = getContextUsage(
      before,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (input.force !== true && !usageBefore.shouldCompress) {
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId,
        reason: "not-needed",
        usage: usageBefore,
      });
      return {
        status: "not-needed",
        usageBefore,
        usageAfter: usageBefore,
      };
    }

    const pruneResult = await prune(sessionId);
    const afterPrune = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageAfterPrune = getContextUsage(
      afterPrune,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    if (input.force !== true && !usageAfterPrune.shouldCompress) {
      return {
        status: pruneResult.prunedCount > 0 ? "pruned" : "not-needed",
        usageBefore,
        usageAfter: usageAfterPrune,
        prune: pruneResult,
      };
    }

    const candidate = await generateSummaryCandidate(
      sessionId,
      afterPrune.history,
    );
    if (candidate.status !== "candidate") {
      publishCompactSkippedForCompression({
        compression: candidate,
        sessionId,
        usage: usageAfterPrune,
      });
      return {
        status: statusForUncommittedCompression({
          compression: candidate,
          pruneResult,
          usageBefore,
          usageAfterPrune,
        }),
        usageBefore,
        usageAfter: usageAfterPrune,
        prune: pruneResult,
        compression: candidate,
        error: candidate.error,
      };
    }

    const projectedContext = projectSummaryCandidate({
      assembled: afterPrune,
      candidate,
      compactedAt: afterPrune.assembledAt,
    });
    const projectedUsage = getContextUsage(
      projectedContext,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );
    if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
      const compression = compressionFromRejectedCandidate(candidate);
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId,
        reason: "inflated",
        usage: usageAfterPrune,
      });
      return {
        status: statusForUncommittedCompression({
          compression,
          pruneResult,
          usageBefore,
          usageAfterPrune,
        }),
        usageBefore,
        usageAfter: usageAfterPrune,
        prune: pruneResult,
        compression,
      };
    }

    const compression = await commitSummaryCandidate(
      sessionId,
      afterPrune.history,
      candidate,
    );
    const afterCompression = await assemble(
      sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageAfter = getContextUsage(
      afterCompression,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );

    return {
      status:
        compression.status === "compressed" &&
        usageAfter.currentTokens < usageBefore.currentTokens
          ? "compacted"
          : statusForUncommittedCompression({
              compression:
                compression.status === "compressed"
                  ? compressionFromRejectedCandidate(candidate)
                  : compression,
              pruneResult,
              usageBefore,
              usageAfterPrune,
            }),
      usageBefore,
      usageAfter,
      prune: pruneResult,
      compression,
      error: compression.error,
    };
  }

  async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    const startedAt = now();
    const assembled = await assemble(
      input.sessionId,
      input.directory,
      input.isSubagent ?? false,
    );
    const usageBefore = getContextUsage(
      assembled,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );
    const action = decideCompactAction({
      force: input.force === true,
      historyLength: assembled.history.length,
      usage: usageBefore,
    });
    if (action === "skip") {
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId: input.sessionId,
        reason: "not-needed",
        usage: usageBefore,
      });
    }
    let compaction: CompactResult | undefined;
    let finalContext = assembled;
    if (action !== "skip") {
      const pruneOutcome = await pruneHistory(
        input.sessionId,
        assembled.history,
      );
      const historyAfterPrune = markCompactedParts(
        assembled.history,
        pruneOutcome.compactedPartIds,
        pruneOutcome.compactedAt,
      );
      const afterPruneContext = {
        ...assembled,
        history: getActiveHistory(historyAfterPrune),
        estimatedTokens: estimateAssembledTokens(
          assembled.systemPrompt,
          assembled.memory,
          getActiveHistory(historyAfterPrune),
        ),
        assembledAt: now(),
      };
      const usageAfterPrune = getContextUsage(
        afterPruneContext,
        input.modelId,
        options.tokenCounter,
        compressionThreshold,
      );

      if (
        action === "prune-only" ||
        (input.force !== true && !usageAfterPrune.shouldCompress)
      ) {
        finalContext = assembleFromRawHistory({
          assembledAt: now(),
          memory: assembled.memory,
          rawHistory: await options.messageManager.listBySession(
            input.sessionId,
          ),
          sessionId: input.sessionId,
          systemPrompt: assembled.systemPrompt,
        });
        const usageAfter = getContextUsage(
          finalContext,
          input.modelId,
          options.tokenCounter,
          compressionThreshold,
        );
        compaction = {
          status: pruneOutcome.result.prunedCount > 0 ? "pruned" : "not-needed",
          usageBefore,
          usageAfter,
          prune: pruneOutcome.result,
        };
      } else {
        const candidate = await generateSummaryCandidate(
          input.sessionId,
          afterPruneContext.history,
        );
        if (candidate.status !== "candidate") {
          finalContext = assembleFromRawHistory({
            assembledAt: now(),
            memory: assembled.memory,
            rawHistory: await options.messageManager.listBySession(
              input.sessionId,
            ),
            sessionId: input.sessionId,
            systemPrompt: assembled.systemPrompt,
          });
          const usageAfter = getContextUsage(
            finalContext,
            input.modelId,
            options.tokenCounter,
            compressionThreshold,
          );
          publishCompactSkippedForCompression({
            compression: candidate,
            sessionId: input.sessionId,
            usage: usageAfter,
          });
          compaction = {
            status: statusForUncommittedCompression({
              compression: candidate,
              pruneResult: pruneOutcome.result,
              usageBefore,
              usageAfterPrune,
            }),
            usageBefore,
            usageAfter,
            prune: pruneOutcome.result,
            compression: candidate,
            error: candidate.error,
          };
        } else {
          const projectedContext = projectSummaryCandidate({
            assembled: afterPruneContext,
            candidate,
            compactedAt: afterPruneContext.assembledAt,
          });
          const projectedUsage = getContextUsage(
            projectedContext,
            input.modelId,
            options.tokenCounter,
            compressionThreshold,
          );

          if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
            const compression = compressionFromRejectedCandidate(candidate);
            options.bus.publish(ContextEvent.CompactSkipped, {
              sessionId: input.sessionId,
              reason: "inflated",
              usage: usageAfterPrune,
            });
            finalContext = assembleFromRawHistory({
              assembledAt: now(),
              memory: assembled.memory,
              rawHistory: await options.messageManager.listBySession(
                input.sessionId,
              ),
              sessionId: input.sessionId,
              systemPrompt: assembled.systemPrompt,
            });
            const usageAfter = getContextUsage(
              finalContext,
              input.modelId,
              options.tokenCounter,
              compressionThreshold,
            );
            compaction = {
              status: statusForUncommittedCompression({
                compression,
                pruneResult: pruneOutcome.result,
                usageBefore,
                usageAfterPrune,
              }),
              usageBefore,
              usageAfter,
              prune: pruneOutcome.result,
              compression,
            };
          } else {
            const compression = await commitSummaryCandidate(
              input.sessionId,
              afterPruneContext.history,
              candidate,
            );
            finalContext = assembleFromRawHistory({
              assembledAt: now(),
              memory: assembled.memory,
              rawHistory: await options.messageManager.listBySession(
                input.sessionId,
              ),
              sessionId: input.sessionId,
              systemPrompt: assembled.systemPrompt,
            });
            const usageAfter = getContextUsage(
              finalContext,
              input.modelId,
              options.tokenCounter,
              compressionThreshold,
            );
            compaction = {
              status:
                compression.status === "compressed" &&
                usageAfter.currentTokens < usageBefore.currentTokens
                  ? "compacted"
                  : statusForUncommittedCompression({
                      compression:
                        compression.status === "compressed"
                          ? compressionFromRejectedCandidate(candidate)
                          : compression,
                      pruneResult: pruneOutcome.result,
                      usageBefore,
                      usageAfterPrune,
                    }),
              usageBefore,
              usageAfter,
              prune: pruneOutcome.result,
              compression,
              error: compression.error,
            };
          }
        }
      }
    }
    const usage = getContextUsage(
      finalContext,
      input.modelId,
      options.tokenCounter,
      compressionThreshold,
    );
    const messages = serializeForLlm({
      history: finalContext.history,
      isSubagent: input.isSubagent ?? false,
      memory: finalContext.memory,
      systemPrompt: finalContext.systemPrompt,
    });

    options.bus.publish(ContextEvent.TurnPrepared, {
      sessionId: input.sessionId,
      tookMs: Math.max(0, now() - startedAt),
      triggeredCompaction:
        compaction !== undefined && compaction.status !== "not-needed",
      usage,
    });

    return {
      assembledAt: finalContext.assembledAt,
      compaction,
      hasSummary: finalContext.hasSummary,
      messages,
      usage,
    };
  }

  return {
    assemble,
    getUsage(context: AssembledContext, modelId: string): ContextUsage {
      return getContextUsage(
        context,
        modelId,
        options.tokenCounter,
        compressionThreshold,
      );
    },
    shouldCompress(usage: ContextUsage): boolean {
      return usage.shouldCompress;
    },
    compress,
    compact,
    prepareTurn,
    prune,
  };
}
