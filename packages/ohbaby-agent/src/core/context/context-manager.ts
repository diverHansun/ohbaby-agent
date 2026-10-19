import { formatEnvironmentDate } from "../system-prompt/layers/environment.js";
import { setTimeout as sleep } from "node:timers/promises";
import { emitDiagnostic, NOOP_LOGGER } from "../../observability/logger.js";
import {
  contextSummaryUnused,
  type UnusedSummaryReason,
} from "../../observability/events.js";
import { estimateHistoryForCompaction } from "./compaction-policy.js";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_COMPACTION_THRESHOLDS,
  KEEP_RECENT_TOKENS,
  SUMMARY_BODY_TOKENS,
  MAX_SUMMARY_PROVIDER_ATTEMPTS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
import type { CompactionThresholds } from "./constants.js";
import { COMPRESSION_PROMPT } from "./compression-prompt.js";
import { ContextEvent } from "./events.js";
import { appendFileOpsSummary, extractFileOps } from "./file-ops.js";
import { isActivePart } from "./filters.js";
import { serializeForLlm, serializeHistoryMessages } from "./serializer.js";
import { createScopedExclusiveLane } from "./scoped-exclusive-lane.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import {
  estimateContextOccupancyComposition,
  estimatePreparedRequestHeuristic,
} from "./token-estimation.js";
import {
  decideCompactionRung,
  findCutPoint,
  historyGroups,
  getContextUsage,
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
import {
  SYSTEM_REMINDER_KIND,
  renderReminderText,
  type MessageWithParts,
  type Part,
} from "../message/index.js";
import type { ReminderDraft } from "../../services/reminder/index.js";
import { arrangeReminderHistory } from "./reminder-history.js";

export {
  decideCompactionRung,
  findCutPoint,
  getContextUsage,
} from "./compaction-policy.js";
export type { CompactionRung, ContextCutPoint } from "./compaction-policy.js";

const CALIBRATION_EMA_ALPHA = 0.5;
const CALIBRATION_FACTOR_MIN = 0.5;
const CALIBRATION_FACTOR_MAX = 3.0;

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
      readonly compactionId: string;
      readonly modelOrigin?: AssembledContext["modelOrigin"];
      readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
      readonly preparedRequest: PreparedModelRequest;
      readonly sourceHistory: readonly MessageWithParts[];
      readonly expectedMessages: readonly MessageWithParts[];
      readonly historyToCompress: readonly MessageWithParts[];
      readonly compactedPartSnapshot: readonly Part[];
      readonly keptIds: readonly string[];
      readonly protectedInputIds: readonly string[];
      readonly readIds: readonly string[];
      readonly omittedPartIds: readonly string[];
      readonly summaryBody: string;
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
}

type AcceptedCompactionRequest = CompactionRequest & {
  readonly attemptId: string;
};

interface CompactionFloor {
  readonly tokens: number;
  readonly capacity: string;
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
  };
  const summaryAgentName = options.summaryAgentName ?? SUMMARY_AGENT_NAME;
  const calibrationFactors = new Map<string, number>();
  const compactionFloors = new Map<string, CompactionFloor>();
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

  function disposeSession(sessionId: string): void {
    for (const map of [calibrationFactors, compactionFloors]) {
      for (const key of map.keys()) {
        if (isScopedSessionKeyForSession(key, sessionId)) map.delete(key);
      }
    }
  }

  function disposeScope(sessionId: string, contextScopeId: string): void {
    const key = scopedSessionKey({ sessionId, contextScopeId });
    calibrationFactors.delete(key);
    compactionFloors.delete(key);
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
    readonly rawHistory: readonly MessageWithParts[];
    readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
    readonly sessionId: string;
    readonly contextScopeId?: string;
    readonly systemPrompt: string;
  }): AssembledContext {
    const history = arrangeReminderHistory(
      getActiveHistory(input.rawHistory),
      input.activeReasoningByMessageId,
      input.modelOrigin,
    );

    return {
      systemPrompt: input.systemPrompt,
      fullHistory: input.rawHistory,
      modelOrigin: input.modelOrigin,
      history,
      hasSummary: history.some(isSummaryMessage),
      isSubagent: input.isSubagent,
      assembledAt: input.assembledAt,
      contextScopeId: input.contextScopeId,
      sessionId: input.sessionId,
    };
  }

  async function assemble(
    sessionId: string,
    directory: string,
    input: ContextAssemblyOptions,
  ): Promise<AssembledContext> {
    const [systemPrompt, rawHistory] = await Promise.all([
      input.promptSnapshot?.systemPrompt ??
        options.systemPromptProvider.build({
          agentName: input.agentName,
          contextScopeId: input.contextScopeId,
          sessionId,
          directory,
          projectRoot: input.projectRoot,
          isSubagent: input.isSubagent,
          toolNames: input.toolNames,
        }),
      loadModelHistory(sessionId, {
        contextScopeId: input.contextScopeId,
      }),
    ]);
    return assembleFromRawHistory({
      modelOrigin: input.modelOrigin,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      assembledAt: now(),
      contextScopeId: input.contextScopeId,
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
    const systemPrompt = await options.systemPromptProvider.build(input);
    let environment: AgentRunPromptSnapshot["environment"];
    try {
      environment =
        await options.systemPromptProvider.detectEnvironment?.(input);
    } catch {
      // Optional environment detection must not prevent a run from preparing.
    }
    return deepFreeze({
      systemPrompt,
      ...(environment === undefined ? {} : { environment }),
    });
  }

  function summaryRequest(
    request: PreparedModelRequest,
    bodyTokens = SUMMARY_BODY_TOKENS,
  ): PreparedModelRequest {
    const reasoning = request.settings?.reasoning;
    const maxTokens =
      reasoning?.budgetTokens !== undefined
        ? bodyTokens + reasoning.budgetTokens
        : reasoning === undefined ||
            reasoning.mode === "none" ||
            reasoning.mode === "disabled"
          ? bodyTokens
          : bodyTokens + SUMMARY_BODY_TOKENS;
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

  function fitsRequest(
    usage: ContextUsage,
    requestedOutputTokens?: number,
  ): boolean {
    return (
      usage.currentTokens +
        (requestedOutputTokens ?? usage.reservedOutputTokens ?? 0) +
        (usage.safetyMarginTokens ?? 0) <=
      usage.contextLimit
    );
  }

  function candidateText(
    body: string,
    historyToCompress: readonly MessageWithParts[],
    omittedPartIds: readonly string[],
  ): string {
    const text = appendFileOpsSummary(body, extractFileOps(historyToCompress));
    return omittedPartIds.length === 0
      ? text
      : `${text}\n\n[Capacity limit: ${String(omittedPartIds.length)} earlier parts were omitted without being summarized.]`;
  }

  function reviseCandidate(
    candidate: CommittableSummaryCandidate,
    keptIds: readonly string[],
    readIds = candidate.readIds,
    summaryBody = candidate.summaryBody,
  ): CommittableSummaryCandidate {
    const kept = new Set(keptIds);
    const read = new Set(readIds);
    const historyToCompress = candidate.sourceHistory.filter(
      (message) => isSummaryMessage(message) || !kept.has(message.info.id),
    );
    const compactedPartSnapshot = historyToCompress.flatMap(
      (message) => message.parts,
    );
    const omittedPartIds = historyToCompress
      .filter(
        (message) => !isSummaryMessage(message) && !read.has(message.info.id),
      )
      .flatMap((message) => message.parts.map((part) => part.id));
    const snapshot = candidateText(
      summaryBody,
      historyToCompress,
      omittedPartIds,
    );
    const originalTokens = estimateHistoryForCompaction(
      historyToCompress,
      options.tokenCounter,
      candidate.modelOrigin,
      candidate.activeReasoningByMessageId,
    );
    const newTokens = tokenCount(options.tokenCounter, snapshot);
    return {
      ...candidate,
      historyToCompress,
      compactedPartSnapshot,
      keptIds,
      readIds,
      omittedPartIds,
      summaryBody,
      snapshot,
      originalTokens,
      newTokens,
      savedTokens: originalTokens - newTokens,
    };
  }

  function requestForSummaryHistory(
    req: AcceptedCompactionRequest,
    history: readonly MessageWithParts[],
    bodyTokens: number,
  ): PreparedModelRequest {
    const context = { ...req.assembled, history };
    return summaryRequest(
      assembleModelRequest({
        requestSettings: req.request.settings,
        inputIds: req.request.inputIds,
        tailDirectives: req.tailDirectives,
        activeReasoningByMessageId: req.activeReasoningByMessageId,
        context,
        isSubagent: req.isSubagent,
        tools: req.tools,
      }),
      bodyTokens,
    );
  }

  async function generateSummaryCandidate(
    req: AcceptedCompactionRequest,
  ): Promise<SummaryCandidate> {
    const sourceHistory = structuredClone(req.assembled.history);
    const { summaries, nonSummary } = partitionSummary(sourceHistory);
    const cut = findCutPoint({
      history: nonSummary,
      keepRecentTokens: KEEP_RECENT_TOKENS,
      modelOrigin: req.assembled.modelOrigin,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      tokenCounter: options.tokenCounter,
    });
    if (cut.firstKeptIndex === 0 && summaries.length < 2)
      return {
        status: "skipped",
        reason: "too-short",
        originalTokens: 0,
        newTokens: 0,
        savedTokens: 0,
      };
    const sourceIds = new Set(sourceHistory.map((message) => message.info.id));
    const expectedMessages = (
      await loadModelHistory(req.sessionId, {
        contextScopeId: req.contextScopeId,
      })
    ).filter((message) => sourceIds.has(message.info.id));
    if (
      JSON.stringify(
        arrangeReminderHistory(
          getActiveHistory(expectedMessages),
          req.activeReasoningByMessageId,
          req.assembled.modelOrigin,
        ),
      ) !== JSON.stringify(sourceHistory)
    )
      return {
        status: "failed",
        error: "Context changed before summary preparation",
        originalTokens: 0,
        newTokens: 0,
        savedTokens: 0,
      };
    const requests: SummaryRequestRecord[] = [];
    let candidate: CommittableSummaryCandidate = {
      status: "candidate",
      compactionId: req.attemptId,
      preparedRequest: req.request,
      modelOrigin: req.assembled.modelOrigin,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      sourceHistory,
      expectedMessages: structuredClone(expectedMessages),
      historyToCompress: [],
      compactedPartSnapshot: [],
      keptIds: cut.keptMessages.map((message) => message.info.id),
      protectedInputIds: req.request.inputIds ?? [],
      readIds: sourceHistory.map((message) => message.info.id),
      omittedPartIds: [],
      summaryBody: "",
      snapshot: "",
      summaryMessageId: randomUUID(),
      originalTokens: 0,
      newTokens: 0,
      savedTokens: 0,
      requests,
    };
    candidate = reviseCandidate(candidate, candidate.keptIds);
    const minimumKeptIds = findCutPoint({
      history: cut.keptMessages,
      keepRecentTokens: 0,
      modelOrigin: req.assembled.modelOrigin,
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      tokenCounter: options.tokenCounter,
    }).keptMessages.map((message) => message.info.id);
    const fail = (error: string): CompressionResult => {
      logUnusedSummaryRequests(requests, "failed");
      return {
        status: "failed",
        originalTokens: candidate.originalTokens,
        newTokens: candidate.originalTokens,
        savedTokens: 0,
        error,
      };
    };
    let readHistory = sourceHistory;
    const prepare = (): boolean => {
      candidate = reviseCandidate(
        candidate,
        candidate.keptIds,
        readHistory.map((message) => message.info.id),
      );
      // Mode B can retire more of the tail, so reserve its possible file-operation suffix now.
      const hostText = reviseCandidate(candidate, minimumKeptIds).snapshot;
      const bodyTokens =
        SUMMARY_BODY_TOKENS - tokenCount(options.tokenCounter, hostText);
      if (bodyTokens <= 0) return false;
      // Preserve the ordinary prepared bytes when no history was removed.
      const preparedRequest =
        readHistory.length === sourceHistory.length
          ? summaryRequest(req.request, bodyTokens)
          : requestForSummaryHistory(req, readHistory, bodyTokens);
      candidate = { ...candidate, preparedRequest };
      return true;
    };
    const trimForCapacity = (providerOverflow?: unknown): boolean => {
      const usage = summaryUsage(candidate.preparedRequest, req);
      let gap =
        usage.currentTokens +
        (candidate.preparedRequest.settings?.maxTokens ?? SUMMARY_BODY_TOKENS) +
        (usage.safetyMarginTokens ?? 0) -
        usage.contextLimit;
      if (gap <= 0 && providerOverflow === undefined) return true;
      const message = errorToMessage(providerOverflow);
      const openaiGap =
        /maximum context length is (\d+) tokens[\s\S]*?(?:requested|resulted in) (\d+) tokens/iu.exec(
          message,
        );
      const anthropicGap =
        /prompt is too long:\s*(\d+) tokens\s*>\s*(\d+)/iu.exec(message);
      const reportedGap = openaiGap
        ? Number(openaiGap[2]) - Number(openaiGap[1])
        : anthropicGap
          ? Number(anthropicGap[1]) - Number(anthropicGap[2])
          : 0;
      // Without a reported gap, only the next complete older group is known to be removable.
      gap = Math.max(1, gap, reportedGap);
      const kept = new Set(candidate.keptIds);
      const removable = historyGroups(nonSummary).filter((group) =>
        group.every(
          (message) =>
            !kept.has(message.info.id) &&
            candidate.readIds.includes(message.info.id),
        ),
      );
      const removed = new Set<string>();
      let removedTokens = 0;
      for (const group of removable) {
        for (const message of group) removed.add(message.info.id);
        removedTokens +=
          estimateHistoryForCompaction(
            group,
            options.tokenCounter,
            req.assembled.modelOrigin,
            req.activeReasoningByMessageId,
          ) * getCalibrationFactor(req.sessionId, req.contextScopeId);
        if (removedTokens >= gap) break;
      }
      if (removed.size === 0) return false;
      readHistory = readHistory.filter(
        (message) => !removed.has(message.info.id),
      );
      return (
        prepare() &&
        fitsRequest(
          summaryUsage(candidate.preparedRequest, req),
          candidate.preparedRequest.settings?.maxTokens ?? SUMMARY_BODY_TOKENS,
        )
      );
    };
    if (!prepare() || !trimForCapacity())
      return fail(
        "Summary request exceeds the model input budget; protected history remains active",
      );

    const observe = (record: SummaryRequestRecord): void => {
      const index = requests.findIndex(
        (existing) => existing.requestId === record.requestId,
      );
      if (index < 0) requests.push(record);
      else requests[index] = record;
    };
    for (let attempt = 1; attempt <= MAX_SUMMARY_PROVIDER_ATTEMPTS; attempt++) {
      if (req.signal?.aborted) {
        logUnusedSummaryRequests(requests, "aborted");
        req.signal.throwIfAborted();
      }
      options.bus.publish(ContextEvent.CompactionProgress, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
        attempt,
        estimatedHistoryTokens: estimateHistoryForCompaction(
          readHistory,
          options.tokenCounter,
          req.assembled.modelOrigin,
          req.activeReasoningByMessageId,
        ),
      });
      try {
        const result = await options.llmClient.generateSummary({
          ...scopedEventIdentity(req.sessionId, req.contextScopeId),
          request: candidate.preparedRequest,
          summaryMessageId: candidate.summaryMessageId,
          compactionId: req.attemptId,
          attempt,
          onRequestRecord: observe,
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        });
        result.requests.forEach(observe);
        const body = result.text.trim();
        if (body === "")
          throw new Error(
            "Summary response was empty; original history remains active",
          );
        candidate = reviseCandidate(
          candidate,
          candidate.keptIds,
          candidate.readIds,
          body,
        );
        if (candidate.newTokens > SUMMARY_BODY_TOKENS) {
          logUnusedSummaryRequests(requests, "summary-body-limit");
          return {
            status: "failed",
            originalTokens: candidate.originalTokens,
            newTokens: candidate.newTokens,
            savedTokens: 0,
            error: "Summary body exceeds 16384 tokens",
          };
        }
        return candidate;
      } catch (error) {
        if (isAbortError(error) || req.signal?.aborted) {
          logUnusedSummaryRequests(requests, "aborted");
          throw error;
        }
        if (attempt < MAX_SUMMARY_PROVIDER_ATTEMPTS) {
          if (isContextOverflowError(error) && trimForCapacity(error)) continue;
          if (isRetryableSummaryError(error)) {
            const cause =
              error instanceof ProviderRetryExhaustedError ||
              error instanceof ProviderStreamInterruptedError
                ? error.cause
                : error;
            try {
              await sleep(
                nextRetryDelayMs({
                  attempt,
                  error: cause,
                  policy: DEFAULT_PROVIDER_RETRY_POLICY,
                }),
                undefined,
                { signal: req.signal },
              );
            } catch (aborted) {
              logUnusedSummaryRequests(requests, "aborted");
              throw aborted;
            }
            continue;
          }
        }
        return fail(errorToMessage(error));
      }
    }
    return fail("Summary provider attempts exhausted");
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
    usageBefore: ContextUsage,
    usageAfter: ContextUsage,
    signal?: AbortSignal,
  ): Promise<CompressionResult | undefined> {
    const compactedAt = now();
    const commit = await options.messageManager.commitCompaction({
      compactedAt,
      expectedParts: candidate.compactedPartSnapshot,
      expectedMessages: candidate.expectedMessages,
      ...(signal === undefined ? {} : { signal }),
      ...(identity.contextScopeId === undefined
        ? {}
        : { contextScopeId: identity.contextScopeId }),
      sessionId: identity.sessionId,
      summary: {
        messageId: candidate.summaryMessageId,
        agent: summaryAgentName,
        text: candidate.snapshot,
        modelRequests: candidate.requests.filter(
          (record) => record.outcome === "success",
        ),
        metadata: {
          compactionId: candidate.compactionId,
          readIds: candidate.readIds,
          keptIds: candidate.keptIds,
          protectedInputIds: candidate.protectedInputIds,
          omittedPartIds: candidate.omittedPartIds,
          usageBeforeTokens: usageBefore.currentTokens,
          usageAfterTokens: usageAfter.currentTokens,
          ...(candidate.omittedPartIds.length === 0
            ? {}
            : { omissionReason: "summary-capacity" }),
        },
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
      omittedParts: candidate.omittedPartIds.length,
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
      activeReasoningByMessageId: input.candidate.activeReasoningByMessageId,
      assembledAt: input.assembled.assembledAt,
      isSubagent: input.assembled.isSubagent,
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
      ...(outcome.compression?.omittedParts === undefined
        ? {}
        : { omittedParts: outcome.compression.omittedParts }),
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
      activeReasoningByMessageId: req.activeReasoningByMessageId,
      assembledAt: now(),
      contextScopeId: req.contextScopeId,
      isSubagent: req.isSubagent,
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
        context,
        isSubagent: req.isSubagent,
        modelId: req.modelId,
        tools: req.tools,
      }).usage,
    };
  }

  async function runCompactionCore(
    req: AcceptedCompactionRequest,
  ): Promise<CompactionOutcome> {
    const preparedSummary = summaryRequest(req.request);
    const summaryCapacity = summaryUsage(preparedSummary, req);
    const ordinaryOutput =
      req.request.settings?.maxTokens ??
      req.usageBefore.reservedOutputTokens ??
      0;
    // Before the ordinary step, leave room for its maximum output and a later summary request.
    const capacityPressure =
      !fitsRequest(req.usageBefore, ordinaryOutput) ||
      summaryCapacity.currentTokens + ordinaryOutput >=
        (summaryCapacity.inputBudgetTokens ?? summaryCapacity.contextLimit);
    const key = scopedSessionKey(req);
    const capacity = JSON.stringify([
      req.modelId,
      req.assembled.modelOrigin,
      req.usageBefore.contextLimit,
      ordinaryOutput,
      req.usageBefore.safetyMarginTokens ?? 0,
      preparedSummary.settings?.maxTokens,
    ]);
    const floor = compactionFloors.get(key);
    const floorApplies =
      !req.force &&
      floor?.capacity === capacity &&
      req.usageBefore.currentTokens <= floor.tokens;
    const rung = floorApplies
      ? "none"
      : decideCompactionRung({
          force: req.force,
          capacityPressure,
          thresholds: compactionThresholds,
          usage: req.usageBefore,
        });
    if (rung === "none") {
      options.bus.publish(ContextEvent.CompactSkipped, {
        ...scopedEventIdentity(req.sessionId, req.contextScopeId),
        attemptId: req.attemptId,
        reason: "not-needed",
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
    let candidate = await generateSummaryCandidate(req);
    if (req.signal?.aborted) {
      if (candidate.status === "candidate")
        logUnusedSummaryRequests(candidate.requests, "aborted");
      req.signal.throwIfAborted();
    }
    if (candidate.status !== "candidate") {
      if (
        candidate.status === "skipped" &&
        !fitsRequest(req.usageBefore, ordinaryOutput)
      ) {
        return {
          status: "failed",
          compression: candidate,
          error:
            "Ordinary request exceeds the model input budget and there is no older group to compact",
          usageBefore: req.usageBefore,
          usageAfter: req.usageBefore,
          projectedContext: req.assembled,
        };
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
    const measureCandidate = (
      value: CommittableSummaryCandidate,
    ): ContextUsage => {
      const context = projectSummaryCandidate({
        assembled: req.assembled,
        candidate: value,
        compactedAt: req.assembled.assembledAt,
      });
      return measureContext({
        requestSettings: req.request.settings,
        inputIds: req.request.inputIds,
        tailDirectives: req.tailDirectives,
        activeReasoningByMessageId: req.activeReasoningByMessageId,
        context,
        isSubagent: req.isSubagent,
        modelId: req.modelId,
        tools: req.tools,
      }).usage;
    };
    let projectedUsage = measureCandidate(candidate);
    if (!fitsRequest(projectedUsage, ordinaryOutput)) {
      const keptIds = new Set(candidate.keptIds);
      const keptHistory = candidate.sourceHistory.filter((message) =>
        keptIds.has(message.info.id),
      );
      // Measure fixed material through the same request builder, including protected input and protocol overhead.
      const fixedUsage = measureCandidate(reviseCandidate(candidate, []));
      const available = Math.max(
        0,
        projectedUsage.contextLimit -
          ordinaryOutput -
          (projectedUsage.safetyMarginTokens ?? 0) -
          fixedUsage.currentTokens,
      );
      const cut = findCutPoint({
        history: keptHistory,
        keepRecentTokens: Math.min(
          KEEP_RECENT_TOKENS,
          available / getCalibrationFactor(req.sessionId, req.contextScopeId),
        ),
        modelOrigin: req.assembled.modelOrigin,
        activeReasoningByMessageId: req.activeReasoningByMessageId,
        tokenCounter: options.tokenCounter,
      });
      candidate = reviseCandidate(
        candidate,
        cut.keptMessages.map((message) => message.info.id),
      );
      projectedUsage = measureCandidate(candidate);
    }
    if (
      candidate.newTokens > SUMMARY_BODY_TOKENS ||
      !fitsRequest(projectedUsage, ordinaryOutput)
    ) {
      logUnusedSummaryRequests(candidate.requests, "failed");
      const error =
        candidate.newTokens > SUMMARY_BODY_TOKENS
          ? "Summary body exceeds 16384 tokens"
          : "Compacted request exceeds the model input budget with the latest complete group preserved";
      return {
        status: "failed",
        error,
        usageBefore: req.usageBefore,
        usageAfter: req.usageBefore,
        projectedContext: req.assembled,
        compression: {
          status: "failed",
          error,
          originalTokens: candidate.originalTokens,
          newTokens: candidate.newTokens,
          savedTokens: 0,
        },
      };
    }
    if (projectedUsage.currentTokens >= req.usageBefore.currentTokens) {
      logUnusedSummaryRequests(candidate.requests, "inflated");
      const compression = compressionFromRejectedCandidate(candidate);
      publishCompactSkippedForCompression({
        attemptId: req.attemptId,
        compression,
        contextScopeId: req.contextScopeId,
        sessionId: req.sessionId,
        usage: req.usageBefore,
      });
      return {
        status: "inflated",
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
        req.usageBefore,
        projectedUsage,
        req.signal,
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
      const current = await reloadCompactionState(req);
      const error =
        "Context changed before the compaction transaction committed";
      return {
        status: "failed",
        error,
        compression: {
          status: "failed",
          error,
          newTokens: candidate.newTokens,
          originalTokens: candidate.originalTokens,
          savedTokens: 0,
        },
        projectedContext: current.context,
        usageAfter: current.usage,
        usageBefore: req.usageBefore,
      };
    }
    // The transaction is the success boundary. Later input or Stop cannot undo this fact.
    logUnusedSummaryRequests(
      candidate.requests.filter((record) => record.outcome !== "success"),
      "failed",
    );
    compactionFloors.set(key, {
      tokens: projectedUsage.currentTokens,
      capacity,
    });
    const current = await reloadCompactionState(req);
    return {
      status: "compacted",
      compression,
      usageBefore: req.usageBefore,
      usageAfter: current.usage,
      projectedContext: current.context,
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
        usageBefore: outcome.usageBefore,
        usageAfter: outcome.usageAfter,
        omittedParts: outcome.compression?.omittedParts,
      });
      return outcome;
    } catch (error) {
      options.bus.publish(ContextEvent.CompactionFinished, {
        ...identity,
        attemptId,
        outcome:
          isAbortError(error) || req.signal?.aborted ? "aborted" : "failed",
        status: "failed",
        usageBefore: req.usageBefore,
      });
      throw error;
    }
  }

  async function compactUnlocked(
    sessionId: string,
    input: CompactOptions,
  ): Promise<CompactResult> {
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(sessionId, input.directory, {
      agentName: input.agentName,
      modelOrigin: input.modelOrigin,
      contextScopeId: input.contextScopeId,
      projectRoot: input.projectRoot,
      isSubagent,
      toolNames: input.toolNames,
    });
    const preparedBefore = measureContext({
      requestSettings: input.requestSettings,
      context: assembled,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const usageBefore = preparedBefore.usage;
    const outcome = await runCompaction({
      request: preparedBefore.request,
      reasoning: input.reasoning,
      assembled,
      contextScopeId: input.contextScopeId,
      force: input.force ?? true,
      isSubagent,
      modelId: input.modelId,
      sessionId,
      signal: input.signal,
      tools: input.tools,
      usageBefore,
    });

    return mapOutcomeToCompactResult(outcome);
  }

  async function collectReminders(
    input: PrepareTurnInput,
    context: AssembledContext,
    date: string,
  ): Promise<readonly ReminderDraft[]> {
    if (
      input.reminderAnchorId === undefined ||
      options.collectReminders === undefined
    )
      return [];
    return options.collectReminders({
      environment:
        input.promptSnapshot?.environment === undefined
          ? undefined
          : { ...input.promptSnapshot.environment, date },
      agentName: input.agentName,
      contextScopeId: input.contextScopeId,
      history: context.history.filter(
        (message) =>
          serializeHistoryMessages(
            [message],
            input.activeReasoningByMessageId,
            input.modelOrigin,
          ).length > 0,
      ),
      fullHistory: context.fullHistory ?? context.history,
      protectedInputs: input.protectedInputs ?? [],
      isSubagent: input.isSubagent ?? false,
      sessionId: input.sessionId,
    });
  }

  function reminderCandidate(
    input: PrepareTurnInput,
    drafts: readonly ReminderDraft[],
  ): MessageWithParts | undefined {
    if (input.reminderAnchorId === undefined || drafts.length === 0)
      return undefined;
    const id = randomUUID();
    return {
      info: {
        id,
        sessionId: input.sessionId,
        contextScopeId: input.contextScopeId,
        runId: input.runId,
        agent: input.agentName ?? "default",
        role: "user",
        time: { created: now() },
      },
      parts: drafts.map((draft, orderIndex) => ({
        id: `${id}:${String(orderIndex)}`,
        messageId: id,
        sessionId: input.sessionId,
        contextScopeId: input.contextScopeId,
        orderIndex,
        type: "text",
        synthetic: true,
        metadata: {
          kind: SYSTEM_REMINDER_KIND,
          reminderType: draft.type,
          key: draft.key,
          anchorAssistantId: input.reminderAnchorId,
        },
        text: renderReminderText(draft.text),
      })),
    };
  }

  /**
   * Persist the selected message's exact contents, without rendering again.
   * A partial save rejects preparation before its assistant is created, so the
   * orphaned reminder cannot replay; a later preparation gets a new anchor.
   */
  async function persistReminders(candidate: MessageWithParts): Promise<void> {
    const message = await options.messageManager.createMessage({
      id: candidate.info.id,
      sessionId: candidate.info.sessionId,
      contextScopeId: candidate.info.contextScopeId,
      runId: candidate.info.runId,
      agent: candidate.info.agent ?? "default",
      role: "user",
    });
    for (const part of candidate.parts) {
      if (part.type !== "text") continue;
      await options.messageManager.appendPart(message.id, {
        type: "text",
        synthetic: true,
        metadata: part.metadata,
        text: part.text,
      });
    }
  }

  async function prepareTurnUnlocked(
    input: PrepareTurnInput & {
      readonly inputIds?: readonly string[];
      readonly protectedTail?: readonly ModelMessage[];
    },
  ): Promise<PreparedTurn> {
    input.signal?.throwIfAborted();
    const startedAt = now();
    const date = formatEnvironmentDate(new Date(startedAt));
    const isSubagent = input.isSubagent ?? false;
    const assembled = await assemble(input.sessionId, input.directory, {
      agentName: input.agentName,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      modelOrigin: input.modelOrigin,
      contextScopeId: input.contextScopeId,
      projectRoot: input.projectRoot,
      isSubagent,
      promptSnapshot: input.promptSnapshot,
      toolNames: input.toolNames,
    });
    // Request tail order: current-run inputs, this anchor's reminders, directives.
    const requestTail = (
      candidate: MessageWithParts | undefined,
    ): readonly ModelMessage[] | undefined => {
      const tail = [
        ...(input.protectedTail ?? []),
        ...(candidate === undefined
          ? []
          : serializeHistoryMessages(
              [candidate],
              input.activeReasoningByMessageId,
              input.modelOrigin,
            )),
        ...(input.tailDirectives ?? []),
      ];
      return tail.length === 0 ? undefined : tail;
    };
    let candidate = reminderCandidate(
      input,
      await collectReminders(input, assembled, date),
    );
    let tailDirectives = requestTail(candidate);
    const preparedBefore = measureContext({
      requestSettings: input.requestSettings,
      inputIds: input.inputIds,
      tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: assembled,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const usageBefore = preparedBefore.usage;
    const outcome = await runCompaction({
      request: preparedBefore.request,
      reasoning: input.reasoning,
      tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      assembled,
      contextScopeId: input.contextScopeId,
      force: input.force === true,
      isSubagent,
      modelId: input.modelId,
      onCompactionStarted: input.onCompactionStarted,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sessionId: input.sessionId,
      tools: input.tools,
      usageBefore,
    });
    const finalContext = outcome.projectedContext;
    if (finalContext !== assembled) {
      // Compaction may have retired earlier state; re-check against the new history.
      candidate = reminderCandidate(
        input,
        await collectReminders(input, finalContext, date),
      );
      tailDirectives = requestTail(candidate);
    }
    const compaction =
      outcome.status === "not-needed"
        ? undefined
        : mapOutcomeToCompactResult(outcome);
    const finalMeasurement = measureContext({
      requestSettings: input.requestSettings,
      inputIds: input.inputIds,
      tailDirectives,
      activeReasoningByMessageId: input.activeReasoningByMessageId,
      context: finalContext,
      isSubagent,
      modelId: input.modelId,
      tools: input.tools,
    });
    const usage = finalMeasurement.usage;
    const request = finalMeasurement.request;
    const composition = estimateContextOccupancyComposition(
      {
        activeReasoningByMessageId: input.activeReasoningByMessageId,
        context: finalContext,
        request,
        tailDirectives,
        toolDefinitions: input.toolDefinitions,
      },
      options.tokenCounter,
    );
    if (
      input.protectedInputs !== undefined &&
      input.inputIds?.length &&
      compaction?.status !== "compacted" &&
      usage.currentTokens > (usage.inputBudgetTokens ?? usage.contextLimit)
    )
      throw new Error(
        "Current-run input batch exceeds the model input budget after context preparation",
      );
    const ready =
      !input.signal?.aborted &&
      compaction?.status !== "failed" &&
      compaction?.status !== "inflated" &&
      (!input.force || compaction?.status === "compacted");
    if (ready && candidate !== undefined) {
      // Keep re-collected reminders whole; lifecycle applies its existing
      // preparation budget check before sending and provider overflow recovery.
      await persistReminders(candidate);
    }

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
      () => {
        snapshot.signal?.throwIfAborted();
        return compactUnlocked(sessionId, snapshot);
      },
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
      protectedTail: protectedProjection,
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
    return {
      ...prepared,
      request: deepFreeze({ ...prepared.request, inputIds }),
    };
  }

  return {
    assemble,
    createRunPromptSnapshot,
    getUsage(input): ReturnType<ContextManager["getUsage"]> {
      const measurement = measureContext({
        context: input.context,
        isSubagent: input.context.isSubagent,
        modelId: input.modelId,
        tools: input.tools,
      });
      const composition = estimateContextOccupancyComposition(
        {
          context: input.context,
          request: measurement.request,
          toolDefinitions: input.toolDefinitions,
        },
        options.tokenCounter,
      );
      return {
        ...measurement.usage,
        ...(composition === undefined ? {} : { composition }),
      };
    },
    updateCalibrationFactor,
    compact,
    prepareTurn,
    disposeScope,
    disposeSession,
  };
}
