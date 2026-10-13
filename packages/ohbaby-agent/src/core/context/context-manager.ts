import { setTimeout as sleep } from "node:timers/promises";
import { emitDiagnostic, NOOP_LOGGER } from "../../observability/logger.js";
import {
  contextSummaryUnused,
  type UnusedSummaryReason,
} from "../../observability/events.js";
import { estimateHistoryForCompaction } from "./compaction-policy.js";
import { randomUUID } from "node:crypto";
import {
  COMPRESSION_PRESERVE_RATIO,
  DEFAULT_COMPACTION_THRESHOLDS,
  MAX_COMPACTION_PER_TURN,
  SUMMARY_BODY_TOKENS,
  MAX_SUMMARY_PROVIDER_ATTEMPTS,
  SUMMARY_AGENT_NAME,
  THRASH_MIN_SAVINGS_RATIO,
  THRASH_UNLOCK_DELTA,
  THRASH_WINDOW,
} from "./constants.js";
import type { CompactionThresholds } from "./constants.js";
import { COMPRESSION_PROMPT } from "./compression-prompt.js";
import { ContextEvent } from "./events.js";
import { appendFileOpsSummary, extractFileOps } from "./file-ops.js";
import { isActivePart } from "./filters.js";
import { createMaskConfig, reduceForModel } from "./projection.js";
import { serializeForLlm, serializeHistoryMessages } from "./serializer.js";
import { createScopedExclusiveLane } from "./scoped-exclusive-lane.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import {
  estimateContextOccupancyComposition,
  estimatePreparedRequestHeuristic,
} from "./token-estimation.js";
import {
  decideCompactionRung,
  getContextUsage,
  getCompactionPressureRatio,
  getHistoryToCompress,
  needsSummaryCompaction,
} from "./compaction-policy.js";
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
  ContextUsage,
  AgentRunPromptSnapshot,
  CreateRunPromptSnapshotInput,
  PreparedModelRequest,
  PreparedTurn,
  PrepareTurnInput,
  TokenCounter,
} from "./types.js";
import type {
  PreparedRequestSettings,
  SummaryRequestRecord,
} from "../llm-client/types.js";
import { isContextOverflowError } from "../llm-client/index.js";
import {
  isRetryableProviderError,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  nextRetryDelayMs,
  DEFAULT_PROVIDER_RETRY_POLICY,
} from "../llm-client/retry.js";
import type { ModelMessage } from "../llm-client/index.js";
import { isModelContextPart, type MessageWithParts } from "../message/index.js";
import type { MergedMemory } from "../memory/index.js";

export {
  decideCompactionRung,
  findCutPoint,
  getContextUsage,
} from "./compaction-policy.js";
export type { CompactionRung, ContextCutPoint } from "./compaction-policy.js";

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
      readonly summaryMessageId: string;
      readonly requests: readonly SummaryRequestRecord[];
    };

type CommittableSummaryCandidate = Extract<
  SummaryCandidate,
  { readonly status: "candidate" }
>;

interface CompactionRequest {
  readonly request: PreparedModelRequest;
  readonly reasoning?: PrepareTurnInput["reasoning"];
  readonly tailDirectives?: readonly ModelMessage[];
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
  readonly compression?: CompressionResult;
  readonly usageBefore: ContextUsage;
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
  if (outcome.status === "compacted") {
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
    actualInputTokens: number,
    sentHeuristic: number,
    contextScopeId?: string,
  ): void {
    if (
      sentHeuristic <= 0 ||
      !Number.isFinite(sentHeuristic) ||
      !Number.isFinite(actualInputTokens)
    ) {
      return;
    }
    const observed = actualInputTokens / sentHeuristic;
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
    if (
      getCompactionPressureRatio(usage) >=
      state.lockedAtUsageRatio + thrashUnlockDelta
    ) {
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
        ? { lockedAtUsageRatio: getCompactionPressureRatio(input.usageBefore) }
        : {}),
    });
  }

  function assembleModelRequest(input: {
    readonly requestSettings?: PreparedRequestSettings;
    readonly inputIds?: readonly string[];
    readonly tailDirectives?: readonly ModelMessage[];
    readonly context: AssembledContext;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
    readonly tools: PrepareTurnInput["tools"];
  }): PreparedModelRequest {
    const messages = serializeForLlm({
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      history: input.context.history,
      modelOrigin: input.context.modelOrigin,
      isSubagent: input.isSubagent,
      memory: input.context.memory,
      systemPrompt: input.context.systemPrompt,
    });
    const request: PreparedModelRequest = structuredClone({
      ...(input.requestSettings === undefined
        ? {}
        : { settings: input.requestSettings }),
      ...(input.inputIds === undefined ? {} : { inputIds: input.inputIds }),
      messages:
        input.tailDirectives === undefined
          ? messages
          : [...messages, ...input.tailDirectives],
      tools: input.tools === undefined ? undefined : [...input.tools],
    });
    return deepFreeze(request);
  }

  function measureUsage(
    request: PreparedModelRequest,
    input: {
      readonly modelId: string;
      readonly sessionId: string;
      readonly contextScopeId?: string;
    },
  ): { readonly sentHeuristic: number; readonly usage: ContextUsage } {
    const sentHeuristic = estimatePreparedRequestHeuristic(
      request,
      options.tokenCounter,
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
        request.settings?.maxTokens,
      ),
    };
  }

  function measureContext(input: {
    readonly requestSettings?: PreparedRequestSettings;
    readonly inputIds?: readonly string[];
    readonly tailDirectives?: readonly ModelMessage[];
    readonly context: AssembledContext;
    readonly modelId: string;
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly isSubagent: boolean;
    readonly tools: PrepareTurnInput["tools"];
  }): {
    readonly request: PreparedModelRequest;
    readonly sentHeuristic: number;
    readonly usage: ContextUsage;
  } {
    const request = assembleModelRequest({
      requestSettings: input.requestSettings,
      inputIds: input.inputIds,
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
    readonly modelOrigin?: AssembledContext["modelOrigin"];
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
      modelOrigin: input.modelOrigin,
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
    tailDirectives?: readonly ModelMessage[],
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
      loadModelHistory(sessionId, {
        contextScopeId: input.contextScopeId,
      }),
    ]);
    return assembleFromRawHistory({
      modelOrigin: input.modelOrigin,
      assembledAt: now(),
      contextScopeId: input.contextScopeId,
      memory,
      rawHistory,
      sessionId,
      systemPrompt,
      isSubagent: input.isSubagent,
    });
  }

  async function loadModelHistory(
    sessionId: string,
    scope: { readonly contextScopeId: string | undefined },
  ): Promise<readonly MessageWithParts[]> {
    const history = await options.messageManager.listBySession(
      sessionId,
      scope,
    );
    // A missing runtime ledger cannot safely infer whether these messages were sent.
    return options.filterModelHistory
      ? options.filterModelHistory(history)
      : history.filter((message) => message.info.runtimeInput === undefined);
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
    const initiatingUserMessageId = input.initiatingUserMessageId;
    if (initiatingUserMessageId !== undefined) {
      await mutationLane.run(
        scopedSessionKey({
          contextScopeId: input.contextScopeId,
          sessionId: input.sessionId,
        }),
        async () => {
          const history = await options.messageManager.listBySession(
            input.sessionId,
            { contextScopeId: input.contextScopeId },
          );
          const initiatingMessage = history.find(
            (message) => message.info.id === initiatingUserMessageId,
          );
          if (initiatingMessage?.info.role !== "user") {
            throw new Error(
              `Initiating user message ${initiatingUserMessageId} is not present in the requested context scope`,
            );
          }
          const alreadyAttached =
            initiatingMessage.parts.some(isModelContextPart);
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
        },
      );
    }

    return deepFreeze({
      memory: { ...memory },
      systemPrompt,
    });
  }

  function summaryRequest(request: PreparedModelRequest): PreparedModelRequest {
    const reasoning = request.settings?.reasoning;
    const maxTokens =
      reasoning?.budgetTokens !== undefined
        ? SUMMARY_BODY_TOKENS + reasoning.budgetTokens
        : reasoning === undefined ||
            reasoning.mode === "none" ||
            reasoning.mode === "disabled"
          ? SUMMARY_BODY_TOKENS
          : SUMMARY_BODY_TOKENS * 2;
    return deepFreeze({
      ...request,
      ...(request.settings === undefined
        ? {}
        : { settings: { ...request.settings, maxTokens } }),
      messages: [
        ...request.messages,
        { role: "user" as const, content: COMPRESSION_PROMPT },
      ],
    });
  }

  function summaryUsage(
    request: PreparedModelRequest,
    identity: {
      readonly modelId: string;
      readonly sessionId: string;
      readonly contextScopeId?: string;
    },
  ): ContextUsage {
    const currentTokens = Math.round(
      estimatePreparedRequestHeuristic(request, options.tokenCounter) *
        getCalibrationFactor(identity.sessionId, identity.contextScopeId),
    );
    return getContextUsage(
      currentTokens,
      identity.modelId,
      options.tokenCounter,
      request.settings?.maxTokens ?? SUMMARY_BODY_TOKENS,
    );
  }

  function isRetryableSummaryError(error: unknown): boolean {
    if (isAbortError(error) || isContextOverflowError(error)) return false;
    if (error instanceof ProviderRetryExhaustedError)
      return isRetryableSummaryError(error.cause);
    if (error instanceof ProviderStreamInterruptedError)
      return error.source === "transport";
    return isRetryableProviderError(error);
  }

  async function generateSummaryCandidate(
    identity: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    },
    rawHistory: readonly MessageWithParts[],
    request: PreparedModelRequest,
    usage: ContextUsage,
    signal?: AbortSignal,
    modelOrigin?: AssembledContext["modelOrigin"],
    activeReasoningByMessageId?: ReadonlyMap<string, string>,
  ): Promise<SummaryCandidate> {
    const activeHistory = getActiveHistory(rawHistory).filter(
      (message) => !isSummaryMessage(message),
    );
    const historyToCompress =
      activeHistory.length <= 2
        ? []
        : getHistoryToCompress({
            history: activeHistory,
            preserveRatio: compressionPreserveRatio,
            modelOrigin,
            activeReasoningByMessageId,
            tokenCounter: options.tokenCounter,
          });
    const originalTokens = estimateHistoryForCompaction(
      historyToCompress,
      options.tokenCounter,
      modelOrigin,
      activeReasoningByMessageId,
    );
    if (historyToCompress.length === 0 || originalTokens === 0)
      return {
        status: "skipped",
        reason: "too-short",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
      };

    if (usage.currentTokens > (usage.inputBudgetTokens ?? usage.contextLimit))
      return {
        status: "failed",
        originalTokens,
        newTokens: originalTokens,
        savedTokens: 0,
        error:
          "Summary request exceeds the model input budget; original history remains active",
      };

    const summaryMessageId = randomUUID();
    const requests: SummaryRequestRecord[] = [];
    const observe = (record: SummaryRequestRecord): void => {
      const index = requests.findIndex(
        (existing) => existing.requestId === record.requestId,
      );
      if (index < 0) requests.push(record);
      else requests[index] = record;
    };
    let snapshot = "";
    for (let attempt = 1; attempt <= MAX_SUMMARY_PROVIDER_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        logUnusedSummaryRequests(requests, "aborted");
        signal.throwIfAborted();
      }
      options.bus.publish(ContextEvent.CompactionProgress, {
        ...identity,
        attempt,
        estimatedHistoryTokens: originalTokens,
      });
      try {
        const result = await options.llmClient.generateSummary({
          request,
          ...scopedEventIdentity(identity.sessionId, identity.contextScopeId),
          summaryMessageId,
          compactionId: identity.attemptId,
          attempt,
          onRequestRecord: observe,
          ...(signal === undefined ? {} : { signal }),
        });
        result.requests.forEach(observe);
        snapshot = result.text.trim();
        if (snapshot === "")
          throw new Error(
            "Summary response was empty; original history remains active",
          );
        break;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          logUnusedSummaryRequests(requests, "aborted");
          throw error;
        }
        if (
          attempt < MAX_SUMMARY_PROVIDER_ATTEMPTS &&
          isRetryableSummaryError(error)
        ) {
          const cause =
            error instanceof ProviderRetryExhaustedError ||
            error instanceof ProviderStreamInterruptedError
              ? error.cause
              : error;
          const delayMs = nextRetryDelayMs({
            attempt,
            error: cause,
            policy: DEFAULT_PROVIDER_RETRY_POLICY,
          });
          try {
            await sleep(delayMs, undefined, { signal });
          } catch (aborted) {
            logUnusedSummaryRequests(requests, "aborted");
            throw aborted;
          }
          continue;
        }
        logUnusedSummaryRequests(requests, "failed");
        return {
          status: "failed",
          originalTokens,
          newTokens: originalTokens,
          savedTokens: 0,
          error: errorToMessage(error),
        };
      }
    }
    if (signal?.aborted) {
      logUnusedSummaryRequests(requests, "aborted");
      signal.throwIfAborted();
    }
    snapshot = appendFileOpsSummary(
      snapshot,
      extractFileOps(historyToCompress),
    );
    const newTokens = tokenCount(options.tokenCounter, snapshot);
    if (newTokens > SUMMARY_BODY_TOKENS) {
      logUnusedSummaryRequests(requests, "summary-body-limit");
      return {
        status: "failed",
        originalTokens,
        newTokens,
        savedTokens: 0,
        error: "Summary body exceeds 16384 tokens",
      };
    }
    if (newTokens >= originalTokens) {
      logUnusedSummaryRequests(requests, "inflated");
      return { status: "inflated", originalTokens, newTokens, savedTokens: 0 };
    }
    return {
      status: "candidate",
      historyToCompress,
      originalTokens,
      newTokens,
      savedTokens: originalTokens - newTokens,
      snapshot,
      summaryMessageId,
      requests,
    };
  }

  function logUnusedSummaryRequests(
    requests: readonly SummaryRequestRecord[],
    reason: UnusedSummaryReason,
  ): void {
    for (const request of requests) {
      const usage = request.usage;
      emitDiagnostic(options.logger ?? NOOP_LOGGER, contextSummaryUnused, {
        operationId: request.requestId,
        compactionId: request.compactionId,
        attempt: request.attempt,
        reason,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        reasoningTokens: usage?.reasoningTokens,
        cacheReadTokens: usage?.inputBreakdown?.observed.cacheRead
          ? usage.inputBreakdown.cacheRead
          : undefined,
        cacheWriteTokens: usage?.inputBreakdown?.observed.cacheWrite
          ? usage.inputBreakdown.cacheWrite
          : undefined,
      });
    }
  }

  async function commitSummaryCandidate(
    identity: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    },
    candidate: CommittableSummaryCandidate,
  ): Promise<CompressionResult | undefined> {
    const compactedAt = now();
    const commit = await options.messageManager.commitCompaction({
      compactedAt,
      expectedParts: candidate.historyToCompress.flatMap((message) =>
        message.parts
          .filter((part) => part.time?.compacted === undefined)
          .map((part) => part),
      ),
      ...(identity.contextScopeId === undefined
        ? {}
        : { contextScopeId: identity.contextScopeId }),
      sessionId: identity.sessionId,
      summary: {
        messageId: candidate.summaryMessageId,
        agent: summaryAgentName,
        text: candidate.snapshot,
      },
    });
    if (commit === undefined) {
      return undefined;
    }
    if (commit.summary === undefined) {
      throw new Error("Compaction commit did not return its summary");
    }

    const result = {
      status: "compressed",
      originalTokens: candidate.originalTokens,
      newTokens: candidate.newTokens,
      savedTokens: candidate.savedTokens,
      summaryMessageId: commit.summary.message.id,
      requests: candidate.requests,
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
      modelOrigin: input.assembled.modelOrigin,
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

  function statusForUncommittedCompression(
    compression: CompressionResult,
  ): CompactStatus {
    if (compression.status === "failed") return "failed";
    if (compression.status === "inflated") return "inflated";
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
      ...(outcome.compression === undefined
        ? {}
        : { compression: outcome.compression }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  async function reloadCompactionState(
    req: AcceptedCompactionRequest,
  ): Promise<{
    readonly context: AssembledContext;
    readonly usage: ContextUsage;
  }> {
    const rawHistory = await loadModelHistory(req.sessionId, {
      contextScopeId: req.contextScopeId,
    });
    const context = assembleFromRawHistory({
      modelOrigin: req.assembled.modelOrigin,
      assembledAt: now(),
      contextScopeId: req.contextScopeId,
      isSubagent: req.isSubagent,
      memory: req.assembled.memory,
      rawHistory,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    return {
      context,
      usage: measureContext({
        requestSettings: req.request.settings,
        inputIds: req.request.inputIds,
        tailDirectives: req.tailDirectives,
        activeReasoningByMessageId: req.activeReasoningByMessageId,
        context: req.projectForUsage?.(context) ?? context,
        isSubagent: req.isSubagent,
        modelId: req.modelId,
        tools: req.tools,
      }).usage,
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
    const preparedSummary = summaryRequest(req.request);
    const summaryCapacity = summaryUsage(preparedSummary, req);
    // Keep room for the ordinary request's known output cap before it grows
    // history; the summary send itself still uses only its independent budget.
    const capacityPressure =
      req.usageBefore.currentTokens >=
        (req.usageBefore.inputBudgetTokens ?? req.usageBefore.contextLimit) ||
      summaryCapacity.currentTokens +
        (req.request.settings?.maxTokens ??
          req.usageBefore.reservedOutputTokens ??
          0) >=
        (summaryCapacity.inputBudgetTokens ?? summaryCapacity.contextLimit);
    const perTurnCapped =
      !req.force &&
      !thrashLocked &&
      (capacityPressure ||
        needsSummaryCompaction(req.usageBefore, compactionThresholds)) &&
      compactionCount >= maxCompactionsPerTurn;
    const rung = decideCompactionRung({
      compactionCount,
      force: req.force,
      capacityPressure,
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
        usageAfter: req.usageBefore,
        projectedContext: req.assembled,
      };
    }

    req.onCompactionStarted?.();

    if (req.countTurnCompaction) {
      incrementTurnCompactionCount(req.sessionId, req.contextScopeId);
    }

    const candidate = await generateSummaryCandidate(
      {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
      },
      req.assembled.history,
      preparedSummary,
      summaryCapacity,
      req.signal,
      req.assembled.modelOrigin,
      req.activeReasoningByMessageId,
    );
    if (req.signal?.aborted) {
      if (candidate.status === "candidate")
        logUnusedSummaryRequests(candidate.requests, "aborted");
      req.signal.throwIfAborted();
    }
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
        usage: req.usageBefore,
      });
      return {
        status: statusForUncommittedCompression(candidate),
        compression: candidate,
        usageBefore: req.usageBefore,
        usageAfter: req.usageBefore,
        projectedContext: req.assembled,
        ...(candidate.status === "failed" ? { error: candidate.error } : {}),
      };
    }

    const projectedContext = projectSummaryCandidate({
      assembled: req.assembled,
      candidate,
      compactedAt: req.assembled.assembledAt,
    });
    const projectedUsage = measureContext({
      requestSettings: req.request.settings,
      inputIds: req.request.inputIds,
      tailDirectives: req.tailDirectives,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      context: req.projectForUsage?.(projectedContext) ?? projectedContext,
      isSubagent: req.isSubagent,
      modelId: req.modelId,
      tools: req.tools,
    }).usage;
    if (projectedUsage.currentTokens >= req.usageBefore.currentTokens) {
      logUnusedSummaryRequests(candidate.requests, "inflated");
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
        usage: req.usageBefore,
      });
      return {
        status: statusForUncommittedCompression(compression),
        compression,
        usageBefore: req.usageBefore,
        usageAfter: req.usageBefore,
        projectedContext: req.assembled,
      };
    }

    let compression: CompressionResult | undefined;
    try {
      req.signal?.throwIfAborted();
      compression = await commitSummaryCandidate(
        {
          ...scopedEventIdentity(req.sessionId, req.contextScopeId),
          attemptId: req.attemptId,
        },
        candidate,
      );
    } catch (error) {
      logUnusedSummaryRequests(
        candidate.requests,
        isAbortError(error) ? "aborted" : "failed",
      );
      throw error;
    }
    if (compression === undefined) {
      logUnusedSummaryRequests(candidate.requests, "stale");
      const staleCompression = {
        newTokens: candidate.newTokens,
        originalTokens: candidate.originalTokens,
        reason: "stale",
        savedTokens: 0,
        status: "skipped",
      } satisfies CompressionResult;
      const current = await reloadCompactionState(req);
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
        reason: "stale",
        usage: current.usage,
      });
      return {
        compression: staleCompression,
        projectedContext: current.context,
        status: "not-needed",
        usageAfter: current.usage,

        usageBefore: req.usageBefore,
      };
    }
    recordThrashSavings({
      compression,
      contextScopeId: req.contextScopeId,
      sessionId: req.sessionId,
      usageBefore: req.usageBefore,
    });
    const committedRawHistory = await loadModelHistory(req.sessionId, {
      contextScopeId: req.contextScopeId,
    });
    const committedContext = assembleFromRawHistory({
      modelOrigin: req.assembled.modelOrigin,
      assembledAt: now(),
      isSubagent: req.isSubagent,
      memory: req.assembled.memory,
      rawHistory: committedRawHistory,
      contextScopeId: req.contextScopeId,
      sessionId: req.sessionId,
      systemPrompt: req.assembled.systemPrompt,
    });
    const usageAfter = measureContext({
      requestSettings: req.request.settings,
      inputIds: req.request.inputIds,
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
          : statusForUncommittedCompression(
              compression.status === "compressed"
                ? compressionFromRejectedCandidate(candidate)
                : compression,
            ),
      compression,
      usageBefore: req.usageBefore,
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
        ...(outcome.status === "compacted" ? { rung: "summary" as const } : {}),
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
      modelOrigin: input.modelOrigin,
      contextScopeId: input.contextScopeId,
      isSubagent,
      toolNames: input.toolNames,
    });
    const unreducedMeasurement = measureContext({
      requestSettings: input.requestSettings,
      context: assembled,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const reducedBeforeCompaction = reduceContextForModel({
      allowCutoffAdvance: true,
      context: assembled,
      publishEvent: true,
      usage: unreducedMeasurement.usage,
    });
    const preparedBefore =
      reducedBeforeCompaction.history === assembled.history
        ? unreducedMeasurement
        : measureContext({
            requestSettings: input.requestSettings,
            context: reducedBeforeCompaction,
            isSubagent,
            modelId: input.modelId,
            tools: input.tools,
          });
    const usageBefore = preparedBefore.usage;
    const outcome = await runCompaction({
      request: preparedBefore.request,
      reasoning: input.reasoning,
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
    input: PrepareTurnInput & { readonly inputIds?: readonly string[] },
  ): Promise<PreparedTurn> {
    const startedAt = now();
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(input.sessionId, input.directory, {
      agentName: input.agentName,
      modelOrigin: input.modelOrigin,
      contextScopeId: input.contextScopeId,
      isSubagent,
      promptSnapshot: input.promptSnapshot,
      toolNames: input.toolNames,
    });
    const unreducedMeasurement = measureContext({
      requestSettings: input.requestSettings,
      inputIds: input.inputIds,
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
    const preparedBefore =
      reducedBeforeCompaction.history === assembled.history
        ? unreducedMeasurement
        : measureContext({
            requestSettings: input.requestSettings,
            inputIds: input.inputIds,
            tailDirectives: input.tailDirectives,
            activeReasoningByMessageId: input.activeReasoningByMessageId,
            context: reducedBeforeCompaction,
            isSubagent,
            modelId: input.modelId,
            tools: input.tools,
          });
    const usageBefore = preparedBefore.usage;
    const outcome = await runCompaction({
      request: preparedBefore.request,
      reasoning: input.reasoning,
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
      outcome.status === "not-needed"
        ? undefined
        : mapOutcomeToCompactResult(outcome);
    const rawFinalMeasurement = measureContext({
      requestSettings: input.requestSettings,
      inputIds: input.inputIds,
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
            requestSettings: input.requestSettings,
            inputIds: input.inputIds,
            tailDirectives: input.tailDirectives,
            activeReasoningByMessageId: input.activeReasoningByMessageId,
            context: reducedFinalContext,
            isSubagent,
            modelId: input.modelId,
            tools: input.tools,
          });
    const usage = finalMeasurement.usage;
    const request = finalMeasurement.request;
    const composition = estimateContextOccupancyComposition(
      {
        activeReasoningByMessageId: input.activeReasoningByMessageId,
        context: reducedFinalContext,
        request,
        tailDirectives: input.tailDirectives,
        toolDefinitions: input.toolDefinitions,
      },
      options.tokenCounter,
    );

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
      ...(composition === undefined ? {} : { composition }),
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
    const snapshot = {
      ...input,
      requestSettings:
        input.requestSettings === undefined
          ? undefined
          : deepFreeze(structuredClone(input.requestSettings)),
      reasoning:
        input.reasoning === undefined
          ? undefined
          : deepFreeze(structuredClone(input.reasoning)),
    };
    return mutationLane.run(
      scopedSessionKey({
        contextScopeId: input.contextScopeId,
        sessionId,
      }),
      () => compactUnlocked(sessionId, snapshot),
    );
  }

  async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    const protectedInputs = structuredClone(input.protectedInputs ?? []);
    const inputIds: string[] = [];
    const protectedProjection: ModelMessage[] = [];
    for (const message of protectedInputs) {
      const origin = message.info.runtimeInput;
      if (
        !origin ||
        !input.runId ||
        origin.targetRunId !== input.runId ||
        message.info.sessionId !== input.sessionId ||
        message.info.contextScopeId !== input.contextScopeId ||
        message.info.role !== "user"
      )
        throw new Error("Protected input owner does not match this run");
      const projected = serializeHistoryMessages(
        [message],
        undefined,
        input.modelOrigin,
      );
      if (!projected.length || inputIds.includes(origin.inputId))
        throw new Error(
          "Protected input has empty or duplicate request membership",
        );
      inputIds.push(origin.inputId);
      protectedProjection.push(...projected);
    }
    const snapshot = {
      ...input,
      requestSettings:
        input.requestSettings === undefined
          ? undefined
          : deepFreeze(structuredClone(input.requestSettings)),
      inputIds,
      // Reuse the measured request-tail pipeline, without making durable inputs
      // part of compressible history or replacing their message/ledger identity.
      tailDirectives: protectedProjection.length
        ? [...protectedProjection, ...(input.tailDirectives ?? [])]
        : input.tailDirectives,
      reasoning:
        input.reasoning === undefined
          ? undefined
          : deepFreeze(structuredClone(input.reasoning)),
    };
    const prepared = await mutationLane.run(
      scopedSessionKey({
        contextScopeId: input.contextScopeId,
        sessionId: input.sessionId,
      }),
      () => prepareTurnUnlocked(snapshot),
    );
    if (input.protectedInputs === undefined) return prepared;
    if (
      inputIds.length &&
      prepared.usage.currentTokens >
        (prepared.usage.inputBudgetTokens ?? prepared.usage.contextLimit)
    )
      throw new Error(
        "Current-run input batch exceeds the model input budget after context preparation",
      );
    return {
      ...prepared,
      request: deepFreeze({ ...prepared.request, inputIds }),
    };
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
