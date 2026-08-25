import { randomUUID } from "node:crypto";
import {
  COMPRESSION_PRESERVE_RATIO,
  DEFAULT_COMPACTION_THRESHOLDS,
  KEEP_RECENT_TOKENS,
  MAX_COMPACTION_PER_TURN,
  MAX_SUMMARY_PROVIDER_ATTEMPTS,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
  THRASH_MIN_SAVINGS_RATIO,
  THRASH_UNLOCK_DELTA,
  THRASH_WINDOW,
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
import { createMaskConfig, reduceForModel } from "./projection.js";
import { serializeForLlm } from "./serializer.js";
import { createScopedExclusiveLane } from "./scoped-exclusive-lane.js";
import { shrinkSummaryHistory } from "./summary-overflow.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import { estimateWireHeuristic } from "./token-estimation.js";
import {
  isScopedSessionKeyForSession,
  scopedSessionKey,
} from "../../utils/scoped-session.js";
import type {
  AssembledContext,
  CompactOptions,
  CompactResult,
  CompactStatus,
  CompressionResult,
  ContextAssemblyOptions,
  ContextManager,
  ContextManagerOptions,
  ContextMeasurementPayload,
  ContextUsage,
  AgentRunPromptSnapshot,
  CreateRunPromptSnapshotInput,
  PreparedTurn,
  PrepareTurnInput,
  PruneResult,
  TokenCounter,
} from "./types.js";
import {
  isContextOverflowError,
  type ChatCompletionMessage,
} from "../llm-client/index.js";
import {
  isModelContextPart,
  type MessageWithParts,
  type Part,
} from "../message/index.js";
import type { MergedMemory } from "../memory/index.js";

const CALIBRATION_EMA_ALPHA = 0.5;
const CALIBRATION_FACTOR_MIN = 0.5;
const CALIBRATION_FACTOR_MAX = 3.0;

const EMPTY_MEMORY: MergedMemory = { global: "", project: "", merged: "" };

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

type SummaryCandidate =
  | CompressionResult
  | {
      readonly status: "candidate";
      readonly historyToCompress: readonly MessageWithParts[];
      readonly newTokens: number;
      readonly originalTokens: number;
      readonly savedTokens: number;
      readonly snapshot: string;
      readonly sourceRevision: string;
    };

type CommittableSummaryCandidate = Extract<
  SummaryCandidate,
  { readonly status: "candidate" }
>;

interface CompactionRequest {
  readonly tailDirectives?: readonly ChatCompletionMessage[];
  readonly assembled: AssembledContext;
  readonly bypassThrashLock: boolean;
  readonly countTurnCompaction: boolean;
  readonly usageBefore: ContextUsage;
  readonly modelId: string;
  readonly onCompactionStarted?: () => void;
  readonly tools: PrepareTurnInput["tools"];
  readonly force: boolean;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly contextScopeId?: string;
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly isSubagent: boolean;
  readonly projectForUsage?: (context: AssembledContext) => AssembledContext;
}

type AcceptedCompactionRequest = CompactionRequest & {
  readonly attemptId: string;
};

interface ThrashLockEntry {
  readonly recentSavingsRatios: readonly number[];
  readonly lockedAtUsageRatio?: number;
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

function scopedEventIdentity(
  sessionId: string,
  contextScopeId: string | undefined,
): { readonly contextScopeId?: string; readonly sessionId: string } {
  return {
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    sessionId,
  };
}

function terminalOutcomeForCompaction(
  outcome: CompactionOutcome,
): "failed" | "inflated" | "skipped" | "success" {
  if (outcome.status === "failed") {
    return "failed";
  }
  if (outcome.status === "inflated") {
    return "inflated";
  }
  if (outcome.status === "compacted" || outcome.status === "pruned") {
    return "success";
  }
  return "skipped";
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

function needsSummaryCompaction(
  usage: ContextUsage,
  thresholds: CompactionThresholds,
): boolean {
  return (
    usage.usageRatio >= thresholds.summary ||
    usage.remainingTokens < thresholds.minRemainingInputTokens
  );
}

function skippedReasonForCompression(
  compression: CompressionResult,
): "inflated" | "stale" | "too-short" | undefined {
  if (compression.status === "inflated") {
    return "inflated";
  }
  if (compression.status === "skipped") {
    return compression.reason;
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

function revisionForHistory(history: readonly MessageWithParts[]): string {
  return JSON.stringify(
    history.map((message) => {
      const { time, ...identity } = message.info;
      return {
        identity,
        parts: message.parts,
        time: {
          completed: time.completed,
          created: time.created,
        },
      };
    }),
  );
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
  const maxCompactionsPerTurn =
    options.maxCompactionsPerTurn ?? MAX_COMPACTION_PER_TURN;
  const thrashWindow = options.thrashWindow ?? THRASH_WINDOW;
  const thrashMinSavingsRatio =
    options.thrashMinSavingsRatio ?? THRASH_MIN_SAVINGS_RATIO;
  const thrashUnlockDelta = options.thrashUnlockDelta ?? THRASH_UNLOCK_DELTA;
  const calibrationFactors = new Map<string, number>();
  const maskCutoffs = new Map<string, number>();
  const thrashLocks = new Map<string, ThrashLockEntry>();
  const turnCompactionCounts = new Map<string, number>();
  const maskConfig = createMaskConfig({
    ...options.maskConfig,
    enabled: options.maskEnabled ?? false,
    minUsageRatio: compactionThresholds.mask,
  });
  const mutationLane = createScopedExclusiveLane();

  function getCalibrationFactor(
    sessionId: string,
    contextScopeId?: string,
  ): number {
    return (
      calibrationFactors.get(scopedSessionKey({ sessionId, contextScopeId })) ??
      1.0
    );
  }

  function updateCalibrationFactor(
    sessionId: string,
    realPromptTokens: number,
    sentHeuristic: number,
    contextScopeId?: string,
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
    const key = scopedSessionKey({ sessionId, contextScopeId });
    const previous = getCalibrationFactor(sessionId, contextScopeId);
    calibrationFactors.set(
      key,
      CALIBRATION_EMA_ALPHA * clamped + (1 - CALIBRATION_EMA_ALPHA) * previous,
    );
  }

  function resetThrashLock(sessionId: string, contextScopeId?: string): void {
    thrashLocks.delete(scopedSessionKey({ sessionId, contextScopeId }));
  }

  function resetTurnCompactionCount(
    sessionId: string,
    contextScopeId?: string,
  ): void {
    turnCompactionCounts.set(
      scopedSessionKey({ sessionId, contextScopeId }),
      0,
    );
  }

  function disposeSession(sessionId: string): void {
    for (const map of [calibrationFactors, maskCutoffs, turnCompactionCounts]) {
      for (const key of map.keys()) {
        if (isScopedSessionKeyForSession(key, sessionId)) {
          map.delete(key);
        }
      }
    }
    for (const key of thrashLocks.keys()) {
      if (isScopedSessionKeyForSession(key, sessionId)) {
        thrashLocks.delete(key);
      }
    }
  }

  function disposeScope(sessionId: string, contextScopeId: string): void {
    const key = scopedSessionKey({ sessionId, contextScopeId });
    calibrationFactors.delete(key);
    maskCutoffs.delete(key);
    turnCompactionCounts.delete(key);
    thrashLocks.delete(key);
  }

  function getTurnCompactionCount(
    sessionId: string,
    contextScopeId?: string,
  ): number {
    return (
      turnCompactionCounts.get(
        scopedSessionKey({ sessionId, contextScopeId }),
      ) ?? 0
    );
  }

  function incrementTurnCompactionCount(
    sessionId: string,
    contextScopeId?: string,
  ): void {
    turnCompactionCounts.set(
      scopedSessionKey({ sessionId, contextScopeId }),
      getTurnCompactionCount(sessionId, contextScopeId) + 1,
    );
  }

  function isThrashLocked(
    sessionId: string,
    usage: ContextUsage,
    contextScopeId?: string,
  ): boolean {
    const key = scopedSessionKey({ sessionId, contextScopeId });
    const state = thrashLocks.get(key);
    if (state?.lockedAtUsageRatio === undefined) {
      return false;
    }
    if (usage.usageRatio >= state.lockedAtUsageRatio + thrashUnlockDelta) {
      thrashLocks.delete(key);
      return false;
    }
    return true;
  }

  function recordThrashSavings(input: {
    readonly compression: CompressionResult;
    readonly sessionId: string;
    readonly contextScopeId?: string;
    readonly usageBefore: ContextUsage;
  }): void {
    if (thrashWindow <= 0) {
      return;
    }
    const ratio =
      input.compression.originalTokens <= 0
        ? 0
        : input.compression.savedTokens / input.compression.originalTokens;
    const key = scopedSessionKey(input);
    const previous = thrashLocks.get(key);
    const recentSavingsRatios = [
      ...(previous?.recentSavingsRatios ?? []),
      ratio,
    ].slice(-thrashWindow);
    const shouldLock =
      recentSavingsRatios.length >= thrashWindow &&
      recentSavingsRatios.every(
        (recentRatio) => recentRatio < thrashMinSavingsRatio,
      );
    thrashLocks.set(key, {
      recentSavingsRatios,
      ...(shouldLock
        ? { lockedAtUsageRatio: input.usageBefore.usageRatio }
        : {}),
    });
  }

  function assembleModelRequest(input: {
    readonly tailDirectives?: readonly ChatCompletionMessage[];
    readonly context: AssembledContext;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
    readonly tools: PrepareTurnInput["tools"];
  }): ContextMeasurementPayload {
    const messages = serializeForLlm({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      history: input.context.history,
      isSubagent: input.isSubagent,
      memory: input.context.memory,
      systemPrompt: input.context.systemPrompt,
    });
    const request: ContextMeasurementPayload = structuredClone({
      messages:
        input.tailDirectives === undefined
          ? messages
          : [...messages, ...input.tailDirectives],
      tools: input.tools === undefined ? undefined : [...input.tools],
    });
    return deepFreeze(request);
  }

  function measureUsage(
    payload: ContextMeasurementPayload,
    input: {
      readonly modelId: string;
      readonly sessionId: string;
      readonly contextScopeId?: string;
    },
  ): { readonly sentHeuristic: number; readonly usage: ContextUsage } {
    const sentHeuristic = estimateWireHeuristic(
      payload.messages,
      options.tokenCounter,
      payload.tools,
    );
    const currentTokens = Math.round(
      sentHeuristic *
        getCalibrationFactor(input.sessionId, input.contextScopeId),
    );
    return {
      sentHeuristic,
      usage: getContextUsage(
        currentTokens,
        input.modelId,
        options.tokenCounter,
      ),
    };
  }

  function measureContext(input: {
    readonly tailDirectives?: readonly ChatCompletionMessage[];
    readonly context: AssembledContext;
    readonly modelId: string;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
    readonly tools: PrepareTurnInput["tools"];
  }): {
    readonly request: ContextMeasurementPayload;
    readonly sentHeuristic: number;
    readonly usage: ContextUsage;
  } {
    const request = assembleModelRequest({
      tailDirectives: input.tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: input.context,
      isSubagent: input.isSubagent,
      tools: input.tools,
    });
    const measurement = measureUsage(request, {
      modelId: input.modelId,
      sessionId: input.context.sessionId,
      contextScopeId: input.context.contextScopeId,
    });
    if (options.onRequestMeasured !== undefined) {
      try {
        options.onRequestMeasured(structuredClone(request));
      } catch (error) {
        options.onWarning?.("Unable to record context measurement", error);
      }
    }
    return {
      request,
      ...measurement,
    };
  }

  function assembleFromRawHistory(input: {
    readonly assembledAt: number;
    readonly isSubagent: boolean;
    readonly memory: MergedMemory;
    readonly rawHistory: readonly MessageWithParts[];
    readonly sessionId: string;
    readonly contextScopeId?: string;
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
      contextScopeId: input.contextScopeId,
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
      cutoff:
        maskCutoffs.get(
          scopedSessionKey({
            contextScopeId: input.context.contextScopeId,
            sessionId: input.context.sessionId,
          }),
        ) ?? 0,
      history: input.context.history,
      sessionId: input.context.sessionId,
      tokenCounter: options.tokenCounter,
      usage: input.usage,
    });
    if (input.allowCutoffAdvance) {
      maskCutoffs.set(
        scopedSessionKey({
          contextScopeId: input.context.contextScopeId,
          sessionId: input.context.sessionId,
        }),
        result.cutoff,
      );
    }
    if (input.publishEvent) {
      options.bus.publish(ContextEvent.Masked, {
        ...result.event,
        ...(input.context.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.context.contextScopeId }),
        maskedPartIds: [...result.event.maskedPartIds],
      });
    }
    return withHistory(input.context, result.history);
  }

  function projectContextForUsage(
    context: AssembledContext,
    modelId: string,
    tools: PrepareTurnInput["tools"],
    tailDirectives?: readonly ChatCompletionMessage[],
  ): AssembledContext {
    return reduceContextForModel({
      allowCutoffAdvance: false,
      context,
      publishEvent: false,
      usage: measureContext({
        tailDirectives,
        context,
        isSubagent: context.isSubagent,
        modelId,
        tools,
      }).usage,
    });
  }

  async function assemble(
    sessionId: string,
    directory: string,
    input: ContextAssemblyOptions,
  ): Promise<AssembledContext> {
    let memory = input.promptSnapshot?.memory ?? EMPTY_MEMORY;
    if (input.promptSnapshot === undefined && !input.isSubagent) {
      try {
        memory = await options.memory.load(directory);
      } catch (error) {
        options.onWarning?.("Unable to load memory for context", error);
      }
    }

    const [systemPrompt, rawHistory] = await Promise.all([
      input.promptSnapshot?.systemPrompt ??
        options.systemPromptProvider.build({
          agentName: input.agentName,
          contextScopeId: input.contextScopeId,
          sessionId,
          directory,
          isSubagent: input.isSubagent,
          toolNames: input.toolNames,
        }),
      options.messageManager.listBySession(sessionId, {
        contextScopeId: input.contextScopeId,
      }),
    ]);
    return assembleFromRawHistory({
      assembledAt: now(),
      contextScopeId: input.contextScopeId,
      memory,
      rawHistory,
      sessionId,
      systemPrompt,
      isSubagent: input.isSubagent,
    });
  }

  async function createRunPromptSnapshot(
    input: CreateRunPromptSnapshotInput,
  ): Promise<AgentRunPromptSnapshot> {
    let memory = EMPTY_MEMORY;
    if (!input.isSubagent) {
      try {
        memory = await options.memory.load(input.directory);
      } catch (error) {
        options.onWarning?.("Unable to load memory for context", error);
      }
    }

    const systemPrompt = await options.systemPromptProvider.build(input);
    if (input.initiatingUserMessageId !== undefined) {
      const history = await options.messageManager.listBySession(
        input.sessionId,
        { contextScopeId: input.contextScopeId },
      );
      const initiatingMessage = history.find(
        (message) => message.info.id === input.initiatingUserMessageId,
      );
      if (initiatingMessage?.info.role !== "user") {
        throw new Error(
          `Initiating user message ${input.initiatingUserMessageId} is not present in the requested context scope`,
        );
      }
      const alreadyAttached = initiatingMessage.parts.some(isModelContextPart);
      if (!alreadyAttached) {
        const runtimeContext =
          await options.systemPromptProvider.buildRuntimeContext?.(input);
        if (runtimeContext !== undefined && runtimeContext.trim() !== "") {
          await options.messageManager.appendModelContextPart(
            initiatingMessage.info.id,
            `\n\n${runtimeContext}`,
          );
        }
      }
    }

    return deepFreeze({
      memory: { ...memory },
      systemPrompt,
    });
  }

  async function pruneHistory(
    identity: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    },
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
      options.bus.publish(ContextEvent.Pruned, { ...identity, result });
      return { compactedPartIds: new Set(), result };
    }

    const compactedAt = now();
    const commit = await options.messageManager.commitCompaction({
      compactedAt,
      compactedPartIds: prunable.map((candidate) => candidate.part.id),
      ...(identity.contextScopeId === undefined
        ? {}
        : { contextScopeId: identity.contextScopeId }),
      sessionId: identity.sessionId,
    });
    const compactedPartIds = new Set(
      commit.updatedParts.map((part) => part.id),
    );

    const result = {
      prunedCount: prunable.length,
      freedTokens,
      protectedCount,
      totalScanned: candidates.length,
    };
    options.bus.publish(ContextEvent.Pruned, { ...identity, result });
    return { compactedAt, compactedPartIds, result };
  }

  async function generateSummaryCandidate(
    identity: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    },
    rawHistory: readonly MessageWithParts[],
    signal?: AbortSignal,
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
        reason: "too-short",
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
        reason: "too-short",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
      };
    }

    let summaryHistory = historyToCompress;
    let snapshot = "";
    let newTokens = originalTokens;
    let providerAttempts = 0;
    let droppedRounds = 0;
    const prompts = [COMPRESSION_PROMPT, AGGRESSIVE_COMPRESSION_PROMPT];
    for (const prompt of prompts) {
      let generatedForPrompt = false;
      while (providerAttempts < MAX_SUMMARY_PROVIDER_ATTEMPTS) {
        providerAttempts += 1;
        options.bus.publish(ContextEvent.CompactionProgress, {
          ...identity,
          attempt: providerAttempts,
          droppedRounds,
          inputTokens: tokenCount(
            options.tokenCounter,
            serializeHistory(summaryHistory, { includeModelContext: false }),
          ),
        });
        try {
          snapshot = await options.llmClient.generateSummary({
            ...scopedEventIdentity(identity.sessionId, identity.contextScopeId),
            prompt,
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            history: summaryHistory,
            ...(signal === undefined ? {} : { signal }),
          });
          generatedForPrompt = true;
          break;
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          if (!isContextOverflowError(error)) {
            return {
              status: "failed",
              originalTokens,
              newTokens: originalTokens,
              savedTokens: 0,
              error: errorToMessage(error),
            };
          }
          if (providerAttempts >= MAX_SUMMARY_PROVIDER_ATTEMPTS) {
            return {
              status: "failed",
              originalTokens,
              newTokens: originalTokens,
              savedTokens: 0,
              error: `Summary context overflow recovery exhausted after ${String(providerAttempts)} attempts`,
              reason: "summary-overflow-exhausted",
            };
          }
          const shrink = shrinkSummaryHistory({
            history: summaryHistory,
            tokenCounter: options.tokenCounter,
          });
          if (shrink === undefined) {
            return {
              status: "failed",
              originalTokens,
              newTokens: originalTokens,
              savedTokens: 0,
              error:
                "Summary context overflow recovery stopped to preserve the most recent user round",
              reason: "summary-overflow-minimum",
            };
          }
          summaryHistory = shrink.history;
          droppedRounds = shrink.droppedRounds;
        }
      }
      if (!generatedForPrompt) {
        break;
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
      sourceRevision: revisionForHistory(activeHistory),
    };
  }

  async function inspectSummaryCandidateRevision(
    assembled: AssembledContext,
    candidate: CommittableSummaryCandidate,
  ): Promise<{
    readonly context: AssembledContext;
    readonly isCurrent: boolean;
  }> {
    const rawHistory = await options.messageManager.listBySession(
      assembled.sessionId,
      {
        contextScopeId: assembled.contextScopeId,
      },
    );
    const context = assembleFromRawHistory({
      assembledAt: now(),
      contextScopeId: assembled.contextScopeId,
      isSubagent: assembled.isSubagent,
      memory: assembled.memory,
      rawHistory,
      sessionId: assembled.sessionId,
      systemPrompt: assembled.systemPrompt,
    });
    const activeHistory = context.history.filter(
      (message) => !isSummaryMessage(message),
    );
    return {
      context,
      isCurrent: revisionForHistory(activeHistory) === candidate.sourceRevision,
    };
  }

  async function commitSummaryCandidate(
    identity: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    },
    candidate: CommittableSummaryCandidate,
  ): Promise<CompressionResult> {
    const compactedAt = now();
    const commit = await options.messageManager.commitCompaction({
      compactedAt,
      compactedPartIds: candidate.historyToCompress.flatMap((message) =>
        message.parts
          .filter((part) => part.time?.compacted === undefined)
          .map((part) => part.id),
      ),
      ...(identity.contextScopeId === undefined
        ? {}
        : { contextScopeId: identity.contextScopeId }),
      sessionId: identity.sessionId,
      summary: {
        agent: summaryAgentName,
        text: candidate.snapshot,
      },
    });
    if (commit.summary === undefined) {
      throw new Error("Compaction commit did not return its summary");
    }

    const result = {
      status: "compressed",
      originalTokens: candidate.originalTokens,
      newTokens: candidate.newTokens,
      savedTokens: candidate.savedTokens,
      summaryMessageId: commit.summary.message.id,
    } satisfies CompressionResult;
    options.bus.publish(ContextEvent.Compressed, { ...identity, result });
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
          contextScopeId: input.assembled.contextScopeId,
          id: `projected_summary_${String(input.compactedAt)}`,
          role: "assistant" as const,
          sessionId: input.assembled.sessionId,
          time: { created: input.compactedAt },
        },
        parts: [
          {
            id: `projected_summary_part_${String(input.compactedAt)}`,
            messageId: `projected_summary_${String(input.compactedAt)}`,
            contextScopeId: input.assembled.contextScopeId,
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
      contextScopeId: input.assembled.contextScopeId,
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
    readonly attemptId: string;
    readonly compression: CompressionResult;
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly usage: ContextUsage;
  }): void {
    const skippedReason = skippedReasonForCompression(input.compression);
    if (skippedReason !== undefined) {
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(input.sessionId, input.contextScopeId),
        attemptId: input.attemptId,
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

  async function runCompactionCore(
    req: AcceptedCompactionRequest,
  ): Promise<CompactionOutcome> {
    const thrashLocked =
      !req.bypassThrashLock &&
      isThrashLocked(req.sessionId, req.usageBefore, req.contextScopeId);
    const compactionCount = getTurnCompactionCount(
      req.sessionId,
      req.contextScopeId,
    );
    const perTurnCapped =
      !req.force &&
      !thrashLocked &&
      needsSummaryCompaction(req.usageBefore, compactionThresholds) &&
      compactionCount >= maxCompactionsPerTurn;
    const rung = decideCompactionRung({
      compactionCount,
      force: req.force,
      maxPerTurn: maxCompactionsPerTurn,
      thresholds: compactionThresholds,
      thrashLocked,
      usage: req.usageBefore,
    });

    if (rung === "none" || rung === "mask") {
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
        reason: thrashLocked
          ? "thrash-locked"
          : perTurnCapped
            ? "per-turn-cap"
            : "not-needed",
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

    req.onCompactionStarted?.();

    if (req.countTurnCompaction) {
      incrementTurnCompactionCount(req.sessionId, req.contextScopeId);
    }

    const pruneOutcome = await pruneHistory(
      {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
      },
      req.assembled.history,
    );
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
      contextScopeId: req.contextScopeId,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    const usageAfterPrune = measureContext({
      tailDirectives: req.tailDirectives,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(afterPrune) ?? afterPrune,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
      tools: req.tools,
    }).usage;

    const afterPruneRung = decideCompactionRung({
      force: false,
      thresholds: compactionThresholds,
      usage: usageAfterPrune,
    });
    if (rung !== "force" && afterPruneRung !== "prune-summary") {
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
      {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
      },
      afterPrune.history,
      req.signal,
    );
    if (candidate.status !== "candidate") {
      if (candidate.status === "inflated") {
        recordThrashSavings({
          compression: candidate,
          contextScopeId: req.contextScopeId,
          sessionId: req.sessionId,
          usageBefore: req.usageBefore,
        });
      }
      publishCompactSkippedForCompression({
        attemptId: req.attemptId,
        compression: candidate,
        contextScopeId: req.contextScopeId,
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
        ...(candidate.status === "failed" ? { error: candidate.error } : {}),
      };
    }

    const revision = await inspectSummaryCandidateRevision(
      afterPrune,
      candidate,
    );
    if (!revision.isCurrent) {
      const compression = {
        newTokens: candidate.newTokens,
        originalTokens: candidate.originalTokens,
        reason: "stale",
        savedTokens: 0,
        status: "skipped",
      } satisfies CompressionResult;
      const currentUsage = measureContext({
        tailDirectives: req.tailDirectives,
        activeReasoningByMessageId: req.activeReasoningByMessageId,
        context: req.projectForUsage?.(revision.context) ?? revision.context,
        isSubagent: req.isSubagent,
        modelId: req.modelId,
        tools: req.tools,
      }).usage;
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
        reason: "stale",
        usage: currentUsage,
      });
      return {
        compression,
        prune: pruneOutcome.result,
        projectedContext: revision.context,
        status: pruneReducedContext({
          pruneResult: pruneOutcome.result,
          usageAfterPrune,
          usageBefore: req.usageBefore,
        })
          ? "pruned"
          : "not-needed",
        usageAfter: currentUsage,
        usageAfterPrune,
        usageBefore: req.usageBefore,
      };
    }

    const projectedContext = projectSummaryCandidate({
      assembled: afterPrune,
      candidate,
      compactedAt: afterPrune.assembledAt,
    });
    const projectedUsage = measureContext({
      tailDirectives: req.tailDirectives,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(projectedContext) ?? projectedContext,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
      tools: req.tools,
    }).usage;
    if (projectedUsage.currentTokens >= usageAfterPrune.currentTokens) {
      const compression = compressionFromRejectedCandidate(candidate);
      recordThrashSavings({
        compression,
        contextScopeId: req.contextScopeId,
        sessionId: req.sessionId,
        usageBefore: req.usageBefore,
      });
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
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
      {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
      },
      candidate,
    );
    recordThrashSavings({
      compression,
      contextScopeId: req.contextScopeId,
      sessionId: req.sessionId,
      usageBefore: req.usageBefore,
    });
    const committedRawHistory = await options.messageManager.listBySession(
      req.sessionId,
      { contextScopeId: req.contextScopeId },
    );
    const committedContext = assembleFromRawHistory({
      assembledAt: now(),
      isSubagent: req.isSubagent,
      memory: req.assembled.memory,
      rawHistory: committedRawHistory,
      contextScopeId: req.contextScopeId,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    const usageAfter = measureContext({
      tailDirectives: req.tailDirectives,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(committedContext) ?? committedContext,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
      tools: req.tools,
    }).usage;
    if (compression.status === "compressed") {
      maskCutoffs.set(
        scopedSessionKey({
          contextScopeId: req.contextScopeId,
          sessionId: req.sessionId,
        }),
        0,
      );
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
      ...(compression.status === "failed" ? { error: compression.error } : {}),
    };
  }

  async function runCompaction(
    req: CompactionRequest,
  ): Promise<CompactionOutcome> {
    const attemptId = randomUUID();
    const identity = scopedEventIdentity(req.sessionId, req.contextScopeId);
    options.bus.publish(ContextEvent.CompactionStarted, {
      ...identity,
      attemptId,
    });
    try {
      const outcome = await runCompactionCore({ ...req, attemptId });
      options.bus.publish(ContextEvent.CompactionFinished, {
        ...identity,
        attemptId,
        outcome: terminalOutcomeForCompaction(outcome),
        ...(outcome.status === "compacted"
          ? { rung: "summary" as const }
          : outcome.status === "pruned"
            ? { rung: "prune" as const }
            : {}),
        status: outcome.status,
      });
      return outcome;
    } catch (error) {
      options.bus.publish(ContextEvent.CompactionFinished, {
        ...identity,
        attemptId,
        outcome: isAbortError(error) ? "aborted" : "failed",
        status: "failed",
      });
      throw error;
    }
  }

  async function compactUnlocked(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    resetThrashLock(sessionId, input.contextScopeId);
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(sessionId, input.directory, {
      agentName: input.agentName,
      contextScopeId: input.contextScopeId,
      isSubagent,
      toolNames: input.toolNames,
    });
    const usageBefore = measureContext({
      context: assembled,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    }).usage;
    const outcome = await runCompaction({
      assembled,
      bypassThrashLock: true,
      countTurnCompaction: false,
      contextScopeId: input.contextScopeId,
      force: input.force === true,
      isSubagent,
      modelId: input.modelId,
      sessionId,
      tools: input.tools,
      usageBefore,
    });

    return mapOutcomeToCompactResult(outcome);
  }

  async function prepareTurnUnlocked(
    input: PrepareTurnInput,
  ): Promise<PreparedTurn> {
    const startedAt = now();
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(input.sessionId, input.directory, {
      agentName: input.agentName,
      contextScopeId: input.contextScopeId,
      isSubagent,
      promptSnapshot: input.promptSnapshot,
      toolNames: input.toolNames,
    });
    const unreducedMeasurement = measureContext({
      tailDirectives: input.tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: assembled,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const unreducedUsage = unreducedMeasurement.usage;
    const reducedBeforeCompaction = reduceContextForModel({
      allowCutoffAdvance: true,
      context: assembled,
      publishEvent: true,
      usage: unreducedUsage,
    });
    const usageBefore =
      reducedBeforeCompaction.history === assembled.history
        ? unreducedUsage
        : measureContext({
            tailDirectives: input.tailDirectives,
            activeReasoningByMessageId: input.activeReasoningByMessageId,
            context: reducedBeforeCompaction,
            isSubagent,
            modelId: input.modelId,
            tools: input.tools,
          }).usage;
    const outcome = await runCompaction({
      tailDirectives: input.tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      assembled,
      bypassThrashLock: input.force === true,
      countTurnCompaction: true,
      contextScopeId: input.contextScopeId,
      force: input.force === true,
      isSubagent,
      modelId: input.modelId,
      onCompactionStarted: input.onCompactionStarted,
      projectForUsage: (context) =>
        projectContextForUsage(
          context,
          input.modelId,
          input.tools,
          input.tailDirectives,
        ),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sessionId: input.sessionId,
      tools: input.tools,
      usageBefore,
    });
    const finalContext = outcome.projectedContext;
    const compaction =
      outcome.status === "not-needed" && outcome.prune === undefined
        ? undefined
        : mapOutcomeToCompactResult(outcome);
    const rawFinalMeasurement = measureContext({
      tailDirectives: input.tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: finalContext,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const rawFinalUsage = rawFinalMeasurement.usage;
    const reducedFinalContext = reduceContextForModel({
      allowCutoffAdvance: false,
      context: finalContext,
      publishEvent: true,
      usage: rawFinalUsage,
    });
    const finalMeasurement =
      reducedFinalContext.history === finalContext.history
        ? rawFinalMeasurement
        : measureContext({
            tailDirectives: input.tailDirectives,
            activeReasoningByMessageId: input.activeReasoningByMessageId,
            context: reducedFinalContext,
            isSubagent,
            modelId: input.modelId,
            tools: input.tools,
          });
    const usage = finalMeasurement.usage;
    const request = finalMeasurement.request;

    options.bus.publish(ContextEvent.TurnPrepared, {
      ...scopedEventIdentity(input.sessionId, input.contextScopeId),
      tookMs: Math.max(0, now() - startedAt),
      triggeredCompaction:
        compaction !== undefined && compaction.status !== "not-needed",
      usage,
    });

    return {
      assembledAt: finalContext.assembledAt,
      compaction,
      hasSummary: finalContext.hasSummary,
      request,
      sentHeuristic: finalMeasurement.sentHeuristic,
      usage,
    };
  }

  function compact(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    return mutationLane.run(
      scopedSessionKey({
        contextScopeId: input.contextScopeId,
        sessionId,
      }),
      () => compactUnlocked(sessionId, input),
    );
  }

  function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    return mutationLane.run(
      scopedSessionKey({
        contextScopeId: input.contextScopeId,
        sessionId: input.sessionId,
      }),
      () => prepareTurnUnlocked(input),
    );
  }

  return {
    assemble,
    createRunPromptSnapshot,
    getUsage(input): ContextUsage {
      return measureContext({
        context: input.context,
        isSubagent: input.context.isSubagent,
        modelId: input.modelId,
        tools: input.tools,
      }).usage;
    },
    updateCalibrationFactor,
    compact,
    prepareTurn,
    resetTurnCompactionCount,
    disposeScope,
    disposeSession,
  };
}
