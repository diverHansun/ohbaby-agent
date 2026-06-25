import {
  COMPRESSION_PRESERVE_RATIO,
  DEFAULT_COMPACTION_THRESHOLDS,
  KEEP_RECENT_TOKENS,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
import type { CompactionThresholds } from "./constants.js";
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
import {
  createMaskConfig,
  reduceForModel,
} from "./projection.js";
import { serializeForLlm } from "./serializer.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import { estimateWireHeuristic } from "./token-estimation.js";
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
import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MessageWithParts, Part } from "../message/index.js";
import type { MergedMemory } from "../memory/index.js";

const CALIBRATION_EMA_ALPHA = 0.5;
const CALIBRATION_FACTOR_MIN = 0.5;
const CALIBRATION_FACTOR_MAX = 3.0;

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

interface CompactionRequest {
  readonly assembled: AssembledContext;
  readonly usageBefore: ContextUsage;
  readonly modelId: string;
  readonly force: boolean;
  readonly sessionId: string;
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly isSubagent: boolean;
  readonly projectForUsage?: (context: AssembledContext) => AssembledContext;
}

interface CompactionOutcome {
  readonly status: CompactStatus;
  readonly prune?: PruneResult;
  readonly compression?: CompressionResult;
  readonly usageBefore: ContextUsage;
  readonly usageAfterPrune: ContextUsage;
  readonly usageAfter: ContextUsage;
  readonly projectedContext: AssembledContext;
  readonly error?: string;
}

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
  readonly force: boolean;
  readonly thresholds?: CompactionThresholds;
}): CompactionRung {
  if (input.force) {
    return "force";
  }
  const thresholds = input.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
  if (
    input.usage.usageRatio >= thresholds.summary ||
    input.usage.remainingTokens < thresholds.minRemainingInputTokens
  ) {
    return "prune-summary";
  }
  if (input.usage.usageRatio >= thresholds.mask) {
    return "mask";
  }
  return "none";
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
      return part;
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

export function createContextManager(
  options: ContextManagerOptions,
): ContextManager {
  const now = options.now ?? Date.now;
  const compactionThresholds: CompactionThresholds = {
    ...DEFAULT_COMPACTION_THRESHOLDS,
    ...options.compactionThresholds,
    ...(options.compressionThreshold === undefined
      ? {}
      : { summary: options.compressionThreshold }),
    ...(options.maskConfig?.minUsageRatio === undefined
      ? {}
      : { mask: options.maskConfig.minUsageRatio }),
  };
  const compressionPreserveRatio =
    options.compressionPreserveRatio ?? COMPRESSION_PRESERVE_RATIO;
  const pruneProtectTokens = options.pruneProtectTokens ?? PRUNE_PROTECT_TOKENS;
  const pruneMinimumTokens = options.pruneMinimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const summaryAgentName = options.summaryAgentName ?? SUMMARY_AGENT_NAME;
  const calibrationFactors = new Map<string, number>();
  const maskCutoffs = new Map<string, number>();
  const maskConfig = createMaskConfig({
    ...options.maskConfig,
    enabled: options.maskEnabled ?? false,
    minUsageRatio: compactionThresholds.mask,
  });

  function getCalibrationFactor(sessionId: string): number {
    return calibrationFactors.get(sessionId) ?? 1.0;
  }

  function updateCalibrationFactor(
    sessionId: string,
    realPromptTokens: number,
    sentHeuristic: number,
  ): void {
    if (
      sentHeuristic <= 0 ||
      !Number.isFinite(sentHeuristic) ||
      !Number.isFinite(realPromptTokens)
    ) {
      return;
    }
    const observed = realPromptTokens / sentHeuristic;
    const clamped = Math.min(
      CALIBRATION_FACTOR_MAX,
      Math.max(CALIBRATION_FACTOR_MIN, observed),
    );
    const previous = getCalibrationFactor(sessionId);
    calibrationFactors.set(
      sessionId,
      CALIBRATION_EMA_ALPHA * clamped +
        (1 - CALIBRATION_EMA_ALPHA) * previous,
    );
  }

  function renderForModel(input: {
    readonly context: AssembledContext;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
  }): ChatCompletionMessage[] {
    return serializeForLlm({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      history: input.context.history,
      isSubagent: input.isSubagent,
      memory: input.context.memory,
      systemPrompt: input.context.systemPrompt,
    });
  }

  function measureUsage(input: {
    readonly messages: readonly ChatCompletionMessage[];
    readonly modelId: string;
    readonly sessionId: string;
  }): { readonly sentHeuristic: number; readonly usage: ContextUsage } {
    const sentHeuristic = estimateWireHeuristic(
      input.messages,
      options.tokenCounter,
    );
    const currentTokens = Math.round(
      sentHeuristic * getCalibrationFactor(input.sessionId),
    );
    return {
      sentHeuristic,
      usage: getContextUsage(currentTokens, input.modelId, options.tokenCounter),
    };
  }

  function measureContext(input: {
    readonly context: AssembledContext;
    readonly modelId: string;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
  }): {
    readonly messages: readonly ChatCompletionMessage[];
    readonly sentHeuristic: number;
    readonly usage: ContextUsage;
  } {
    const messages = renderForModel({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: input.context,
      isSubagent: input.isSubagent,
    });
    return {
      messages,
      ...measureUsage({
        messages,
        modelId: input.modelId,
        sessionId: input.context.sessionId,
      }),
    };
  }

  function assembleFromRawHistory(input: {
    readonly assembledAt: number;
    readonly isSubagent: boolean;
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
      hasSummary: input.rawHistory.some(isSummaryMessage),
      isSubagent: input.isSubagent,
      assembledAt: input.assembledAt,
      sessionId: input.sessionId,
    };
  }

  function withHistory(
    context: AssembledContext,
    history: readonly MessageWithParts[],
  ): AssembledContext {
    return { ...context, history };
  }

  function reduceContextForModel(input: {
    readonly context: AssembledContext;
    readonly usage: ContextUsage;
    readonly allowCutoffAdvance: boolean;
    readonly publishEvent: boolean;
  }): AssembledContext {
    const result = reduceForModel({
      allowCutoffAdvance: input.allowCutoffAdvance,
      config: maskConfig,
      cutoff: maskCutoffs.get(input.context.sessionId) ?? 0,
      history: input.context.history,
      sessionId: input.context.sessionId,
      tokenCounter: options.tokenCounter,
      usage: input.usage,
    });
    if (input.allowCutoffAdvance) {
      maskCutoffs.set(input.context.sessionId, result.cutoff);
    }
    if (input.publishEvent) {
      options.bus.publish(ContextEvent.Masked, {
        ...result.event,
        maskedPartIds: [...result.event.maskedPartIds],
      });
    }
    return withHistory(input.context, result.history);
  }

  function projectContextForUsage(
    context: AssembledContext,
    modelId: string,
  ): AssembledContext {
    return reduceContextForModel({
      allowCutoffAdvance: false,
      context,
      publishEvent: false,
      usage: measureContext({
        context,
        isSubagent: context.isSubagent,
        modelId,
      }).usage,
    });
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
      isSubagent,
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

    const result = {
      prunedCount: prunable.length,
      freedTokens,
      protectedCount,
      totalScanned: candidates.length,
    };
    options.bus.publish(ContextEvent.Pruned, { sessionId, result });
    return { compactedAt, compactedPartIds, result };
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
      isSubagent: input.assembled.isSubagent,
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

  function mapOutcomeToCompactResult(
    outcome: CompactionOutcome,
  ): CompactResult {
    return {
      status: outcome.status,
      usageBefore: outcome.usageBefore,
      usageAfter: outcome.usageAfter,
      ...(outcome.prune === undefined ? {} : { prune: outcome.prune }),
      ...(outcome.compression === undefined
        ? {}
        : { compression: outcome.compression }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  async function runCompaction(
    req: CompactionRequest,
  ): Promise<CompactionOutcome> {
    const rung = decideCompactionRung({
      force: req.force,
      thresholds: compactionThresholds,
      usage: req.usageBefore,
    });

    if (rung === "none" || rung === "mask") {
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId: req.sessionId,
        reason: "not-needed",
        usage: req.usageBefore,
      });
      return {
        status: "not-needed",
        usageBefore: req.usageBefore,
        usageAfterPrune: req.usageBefore,
        usageAfter: req.usageBefore,
        projectedContext: req.assembled,
      };
    }

    const pruneOutcome = await pruneHistory(req.sessionId, req.assembled.history);
    const historyAfterPrune = markCompactedParts(
      req.assembled.history,
      pruneOutcome.compactedPartIds,
      pruneOutcome.compactedAt,
    );
    const afterPrune = assembleFromRawHistory({
      assembledAt: now(),
      isSubagent: req.isSubagent,
      memory: req.assembled.memory,
      rawHistory: historyAfterPrune,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    const usageAfterPrune = measureContext({
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(afterPrune) ?? afterPrune,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
    }).usage;

    const afterPruneRung = decideCompactionRung({
      force: false,
      thresholds: compactionThresholds,
      usage: usageAfterPrune,
    });
    if (rung !== "force" && afterPruneRung === "none") {
      return {
        status: pruneOutcome.result.prunedCount > 0 ? "pruned" : "not-needed",
        prune: pruneOutcome.result,
        usageBefore: req.usageBefore,
        usageAfterPrune,
        usageAfter: usageAfterPrune,
        projectedContext: afterPrune,
      };
    }

    const candidate = await generateSummaryCandidate(
      req.sessionId,
      afterPrune.history,
    );
    if (candidate.status !== "candidate") {
      publishCompactSkippedForCompression({
        compression: candidate,
        sessionId: req.sessionId,
        usage: usageAfterPrune,
      });
      return {
        status: statusForUncommittedCompression({
          compression: candidate,
          pruneResult: pruneOutcome.result,
          usageBefore: req.usageBefore,
          usageAfterPrune,
        }),
        prune: pruneOutcome.result,
        compression: candidate,
        usageBefore: req.usageBefore,
        usageAfterPrune,
        usageAfter: usageAfterPrune,
        projectedContext: afterPrune,
        error: candidate.error,
      };
    }

    const projectedContext = projectSummaryCandidate({
      assembled: afterPrune,
      candidate,
      compactedAt: afterPrune.assembledAt,
    });
    const projectedUsage = measureContext({
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(projectedContext) ?? projectedContext,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
    }).usage;
    if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
      const compression = compressionFromRejectedCandidate(candidate);
      options.bus.publish(ContextEvent.CompactSkipped, {
        sessionId: req.sessionId,
        reason: "inflated",
        usage: usageAfterPrune,
      });
      return {
        status: statusForUncommittedCompression({
          compression,
          pruneResult: pruneOutcome.result,
          usageBefore: req.usageBefore,
          usageAfterPrune,
        }),
        prune: pruneOutcome.result,
        compression,
        usageBefore: req.usageBefore,
        usageAfterPrune,
        usageAfter: usageAfterPrune,
        projectedContext: afterPrune,
      };
    }

    const compression = await commitSummaryCandidate(
      req.sessionId,
      candidate,
    );
    const committedRawHistory = await options.messageManager.listBySession(
      req.sessionId,
    );
    const committedContext = assembleFromRawHistory({
      assembledAt: now(),
      isSubagent: req.isSubagent,
      memory: req.assembled.memory,
      rawHistory: committedRawHistory,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    const usageAfter = measureContext({
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(committedContext) ?? committedContext,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
    }).usage;
    if (compression.status === "compressed") {
      maskCutoffs.set(req.sessionId, 0);
    }

    return {
      status:
        compression.status === "compressed" &&
        usageAfter.currentTokens < req.usageBefore.currentTokens
          ? "compacted"
          : statusForUncommittedCompression({
              compression:
                compression.status === "compressed"
                  ? compressionFromRejectedCandidate(candidate)
                  : compression,
              pruneResult: pruneOutcome.result,
              usageBefore: req.usageBefore,
              usageAfterPrune,
            }),
      prune: pruneOutcome.result,
      compression,
      usageBefore: req.usageBefore,
      usageAfterPrune,
      usageAfter,
      projectedContext: committedContext,
      error: compression.error,
    };
  }

  async function compact(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(
      sessionId,
      input.directory,
      isSubagent,
    );
    const usageBefore = measureContext({
      context: assembled,
      isSubagent,
      modelId: input.modelId,
    }).usage;
    const outcome = await runCompaction({
      assembled,
      force: input.force === true,
      isSubagent,
      modelId: input.modelId,
      sessionId,
      usageBefore,
    });

    return mapOutcomeToCompactResult(outcome);
  }

  async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    const startedAt = now();
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(
      input.sessionId,
      input.directory,
      isSubagent,
    );
    const unreducedUsage = measureContext({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: assembled,
      isSubagent,
      modelId: input.modelId,
    }).usage;
    const reducedBeforeCompaction = reduceContextForModel({
      allowCutoffAdvance: true,
      context: assembled,
      publishEvent: true,
      usage: unreducedUsage,
    });
    const usageBefore = measureContext({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: reducedBeforeCompaction,
      isSubagent,
      modelId: input.modelId,
    }).usage;
    const outcome = await runCompaction({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      assembled,
      force: input.force === true,
      isSubagent,
      modelId: input.modelId,
      projectForUsage: (context) =>
        projectContextForUsage(context, input.modelId),
      sessionId: input.sessionId,
      usageBefore,
    });
    const finalContext = outcome.projectedContext;
    const compaction =
      outcome.status === "not-needed" && outcome.prune === undefined
        ? undefined
        : mapOutcomeToCompactResult(outcome);
    const rawFinalUsage = measureContext({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: finalContext,
      isSubagent,
      modelId: input.modelId,
    }).usage;
    const reducedFinalContext = reduceContextForModel({
      allowCutoffAdvance: false,
      context: finalContext,
      publishEvent: true,
      usage: rawFinalUsage,
    });
    const finalMeasurement = measureContext({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: reducedFinalContext,
      isSubagent,
      modelId: input.modelId,
    });
    const usage = finalMeasurement.usage;
    const messages = finalMeasurement.messages;

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
      sentHeuristic: finalMeasurement.sentHeuristic,
      usage,
    };
  }

  return {
    assemble,
    getUsage(context: AssembledContext, modelId: string): ContextUsage {
      return measureContext({
        context,
        isSubagent: context.isSubagent,
        modelId,
      }).usage;
    },
    updateCalibrationFactor,
    compact,
    prepareTurn,
  };
}
