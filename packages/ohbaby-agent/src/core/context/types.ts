import type { BusInstance } from "../../bus/index.js";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageManager, MessageWithParts } from "../message/index.js";
import type { CompactionThresholds } from "./constants.js";

export interface MemoryReader {
  load(directory: string): Promise<MergedMemory>;
}

export interface SystemPromptProviderInput {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly isSubagent: boolean;
  readonly agentName?: string;
  readonly toolNames: readonly string[];
}

export interface SystemPromptProvider {
  build(input: SystemPromptProviderInput): Promise<string>;
  buildRuntimeContext?(input: SystemPromptProviderInput): Promise<string>;
}

export interface TokenCounter {
  estimateTokens(content: string): number;
  getBudget?(
    modelId: string,
    options?: {
      readonly requestedOutputTokens?: number;
      readonly safetyMarginTokens?: number;
      readonly usedInputTokens?: number;
    },
  ): {
    readonly contextWindowTokens: number;
    readonly inputBudgetTokens: number;
    readonly maxOutputTokens: number;
    readonly modelId: string;
    readonly remainingInputTokens: number;
    readonly reservedOutputTokens: number;
    readonly safetyMarginTokens: number;
    readonly usageRatio: number;
    readonly usedInputTokens: number;
  };
  getLimit(modelId: string): number;
}

export interface ContextLLMClient {
  generateSummary(input: {
    readonly sessionId: string;
    readonly contextScopeId?: string;
    readonly prompt: string;
    readonly systemPrompt?: string;
    readonly history: readonly MessageWithParts[];
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface AssembledContext {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly hasSummary: boolean;
  readonly assembledAt: number;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly isSubagent: boolean;
}

export interface ContextAssemblyOptions {
  readonly agentName?: string;
  readonly contextScopeId?: string;
  readonly isSubagent: boolean;
  readonly toolNames: readonly string[];
  readonly promptSnapshot?: AgentRunPromptSnapshot;
}

export interface AgentRunPromptSnapshot {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
}

export interface CreateRunPromptSnapshotInput extends SystemPromptProviderInput {
  /** Attach dynamic model-only context only for a newly initiated run. */
  readonly initiatingUserMessageId?: string;
}

export interface PreparedModelRequest {
  readonly messages: readonly ChatCompletionMessage[];
  readonly tools: ChatCompletionCreateParams["tools"];
}

export interface ContextUsage {
  readonly currentTokens: number;
  readonly contextLimit: number;
  readonly inputBudgetTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly usageRatio: number;
  readonly remainingTokens: number;
  readonly modelId: string;
}

export type CompressionStatus =
  | "compressed"
  | "skipped"
  | "failed"
  | "inflated";

export type CompressionSkipReason = "stale" | "too-short";
export type CompressionFailureReason =
  | "summary-overflow-exhausted"
  | "summary-overflow-minimum";

interface CompressionMetrics {
  readonly originalTokens: number;
  readonly newTokens: number;
  readonly savedTokens: number;
}

export type CompressionResult =
  | (CompressionMetrics & {
      readonly status: "compressed";
      readonly summaryMessageId: string;
    })
  | (CompressionMetrics & {
      readonly status: "skipped";
      readonly reason: CompressionSkipReason;
    })
  | (CompressionMetrics & {
      readonly status: "failed";
      readonly error: string;
      readonly reason?: CompressionFailureReason;
    })
  | (CompressionMetrics & { readonly status: "inflated" });

export interface PruneResult {
  readonly prunedCount: number;
  readonly freedTokens: number;
  readonly protectedCount: number;
  readonly totalScanned: number;
}

export type CompactStatus =
  | "not-needed"
  | "pruned"
  | "compacted"
  | "failed"
  | "inflated";

export interface CompactOptions {
  readonly agentName?: string;
  readonly directory: string;
  readonly contextScopeId?: string;
  readonly force?: boolean;
  readonly isSubagent?: boolean;
  readonly modelId: string;
  readonly toolNames: readonly string[];
  readonly tools: ChatCompletionCreateParams["tools"];
}

export interface CompactResult {
  readonly status: CompactStatus;
  readonly usageBefore: ContextUsage;
  readonly usageAfter: ContextUsage;
  readonly prune?: PruneResult;
  readonly compression?: CompressionResult;
  readonly error?: string;
}

export interface PrepareTurnInput {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
  /** Stable system and memory captured once for this lifecycle run. */
  readonly promptSnapshot?: AgentRunPromptSnapshot;
  readonly agentName?: string;
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  /** Fires once after an actual automatic compaction rung is selected, before history mutation. */
  readonly onCompactionStarted?: () => void;
  /** Ephemeral model-only directives measured and sent exactly once, but never persisted. */
  readonly tailDirectives?: readonly ChatCompletionMessage[];
  readonly toolNames: readonly string[];
  readonly tools: ChatCompletionCreateParams["tools"];
  readonly isSubagent?: boolean;
  readonly force?: boolean;
}

export interface PreparedTurn {
  /** The single measured request snapshot consumed by the provider call. */
  readonly request: PreparedModelRequest;
  readonly usage: ContextUsage;
  readonly compaction?: CompactResult;
  readonly assembledAt: number;
  readonly hasSummary: boolean;
  readonly sentHeuristic: number;
}

export interface ContextManager {
  assemble(
    sessionId: string,
    directory: string,
    options: ContextAssemblyOptions,
  ): Promise<AssembledContext>;
  getUsage(input: {
    readonly context: AssembledContext;
    readonly modelId: string;
    readonly tools: ChatCompletionCreateParams["tools"];
  }): ContextUsage;
  createRunPromptSnapshot(
    input: CreateRunPromptSnapshotInput,
  ): Promise<AgentRunPromptSnapshot>;
  updateCalibrationFactor(
    sessionId: string,
    realPromptTokens: number,
    sentHeuristic: number,
    contextScopeId?: string,
  ): void;
  compact(sessionId: string, options: CompactOptions): Promise<CompactResult>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
  resetTurnCompactionCount(sessionId: string, contextScopeId?: string): void;
  disposeScope(sessionId: string, contextScopeId: string): void;
  disposeSession(sessionId: string): void;
}

export interface ContextManagerOptions {
  readonly bus: BusInstance;
  readonly memory: MemoryReader;
  readonly messageManager: MessageManager;
  readonly systemPromptProvider: SystemPromptProvider;
  readonly tokenCounter: TokenCounter;
  readonly llmClient: ContextLLMClient;
  readonly now?: () => number;
  readonly compactionThresholds?: Partial<CompactionThresholds>;
  readonly compressionThreshold?: number;
  readonly compressionPreserveRatio?: number;
  readonly pruneProtectTokens?: number;
  readonly pruneMinimumTokens?: number;
  readonly summaryAgentName?: string;
  readonly maxCompactionsPerTurn?: number;
  readonly thrashWindow?: number;
  readonly thrashMinSavingsRatio?: number;
  readonly thrashUnlockDelta?: number;
  readonly maskEnabled?: boolean;
  readonly maskConfig?: {
    readonly exemptToolPrefixes?: readonly string[];
    readonly minPartTokens?: number;
    readonly minPrunableTokens?: number;
    readonly minUsageRatio?: number;
    readonly placeholderPrefix?: string;
    readonly protectionTokens?: number;
  };
  /** Receives a detached copy of each occupancy payload for diagnostics and tests. */
  readonly onRequestMeasured?: (request: PreparedModelRequest) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
}
