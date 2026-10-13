import type {
  PreparedRequestSettings,
  SummaryRequestRecord,
} from "../llm-client/types.js";
import type { ReasoningIntent } from "../../services/interface-providers/reasoning.js";
import type { ModelOrigin } from "../../services/interface-providers/native-state.js";
import type { BusInstance } from "../../bus/index.js";
import type { ModelMessage, ModelToolDefinition } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageManager, MessageWithParts } from "../message/index.js";
import type { ToolDefinition } from "../tool-scheduler/index.js";
import type { CompactionThresholds } from "./constants.js";
import type { Logger } from "../../observability/logger.js";

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

export interface SummaryRequestResult {
  readonly text: string;
  readonly summaryMessageId: string;
  readonly requests: readonly SummaryRequestRecord[];
}

export interface ContextLLMClient {
  generateSummary(input: {
    readonly request: PreparedModelRequest;
    readonly sessionId: string;
    readonly contextScopeId?: string;
    readonly summaryMessageId: string;
    readonly compactionId: string;
    readonly attempt: number;
    readonly onRequestRecord?: (record: SummaryRequestRecord) => void;
    readonly signal?: AbortSignal;
  }): Promise<SummaryRequestResult>;
}

export interface AssembledContext {
  readonly modelOrigin?: ModelOrigin;
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
  readonly modelOrigin?: ModelOrigin;
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
  readonly settings?: PreparedRequestSettings;
  readonly inputIds?: readonly string[];
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[] | undefined;
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

export interface ContextOccupancyComposition {
  readonly "system-prompt": number;
  readonly "builtin-tools": number;
  readonly mcp: number;
  readonly skills: number;
  readonly conversation: number;
  readonly "summarized-conversation": number;
  readonly "subagent-exchanges": number;
}

export type CompressionStatus =
  | "compressed"
  | "skipped"
  | "failed"
  | "inflated";

export type CompressionSkipReason = "stale" | "too-short";

interface CompressionMetrics {
  readonly omittedParts?: number;
  readonly requests?: readonly SummaryRequestRecord[];
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
    })
  | (CompressionMetrics & { readonly status: "inflated" });

export type CompactStatus = "not-needed" | "compacted" | "failed" | "inflated";

export interface CompactOptions {
  readonly signal?: AbortSignal;
  readonly requestSettings?: PreparedRequestSettings;
  readonly reasoning?: ReasoningIntent;
  readonly modelOrigin?: ModelOrigin;
  readonly agentName?: string;
  readonly directory: string;
  readonly contextScopeId?: string;
  readonly force?: boolean;
  readonly isSubagent?: boolean;
  readonly modelId: string;
  readonly toolNames: readonly string[];
  readonly tools: readonly ModelToolDefinition[] | undefined;
}

export interface CompactResult {
  readonly omittedParts?: number;
  readonly status: CompactStatus;
  readonly usageBefore: ContextUsage;
  readonly usageAfter: ContextUsage;
  readonly compression?: CompressionResult;
  readonly error?: string;
}

export interface PrepareTurnInput {
  readonly requestSettings?: PreparedRequestSettings;
  readonly runId?: string;
  /** Durable first-delivery inputs, excluded from compressible history. */
  readonly protectedInputs?: readonly MessageWithParts[];
  readonly reasoning?: ReasoningIntent;
  readonly modelOrigin?: ModelOrigin;
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
  readonly tailDirectives?: readonly ModelMessage[];
  readonly toolNames: readonly string[];
  readonly toolDefinitions?: readonly ToolDefinition[];
  readonly tools: readonly ModelToolDefinition[] | undefined;
  readonly isSubagent?: boolean;
  readonly force?: boolean;
}

export interface PreparedTurn {
  /** The immutable prepared request actually consumed by the provider call. */
  readonly request: PreparedModelRequest;
  readonly usage: ContextUsage;
  readonly composition?: ContextOccupancyComposition;
  readonly compaction?: CompactResult;
  readonly assembledAt: number;
  readonly hasSummary: boolean;
  /** Raw model-request estimate for this exact request, not provider wire-token usage. */
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
    readonly tools: readonly ModelToolDefinition[] | undefined;
    readonly toolDefinitions?: readonly ToolDefinition[];
  }): ContextUsage & { readonly composition?: ContextOccupancyComposition };
  createRunPromptSnapshot(
    input: CreateRunPromptSnapshotInput,
  ): Promise<AgentRunPromptSnapshot>;
  updateCalibrationFactor(
    sessionId: string,
    actualInputTokens: number,
    sentHeuristic: number,
    contextScopeId?: string,
  ): void;
  compact(sessionId: string, options: CompactOptions): Promise<CompactResult>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
  disposeScope(sessionId: string, contextScopeId: string): void;
  disposeSession(sessionId: string): void;
}

export interface ContextManagerOptions {
  readonly logger?: Logger;
  /** Ledger-backed projection: pending/unsent runtime inputs cannot enter summaries. */
  readonly filterModelHistory?: (
    messages: readonly MessageWithParts[],
  ) => Promise<readonly MessageWithParts[]>;
  readonly bus: BusInstance;
  readonly memory: MemoryReader;
  readonly messageManager: MessageManager;
  readonly systemPromptProvider: SystemPromptProvider;
  readonly tokenCounter: TokenCounter;
  readonly llmClient: ContextLLMClient;
  readonly now?: () => number;
  readonly compactionThresholds?: Partial<CompactionThresholds>;
  readonly compressionThreshold?: number;
  readonly summaryAgentName?: string;
  /** Receives a detached copy of each occupancy payload for diagnostics and tests. */
  readonly onRequestMeasured?: (request: PreparedModelRequest) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
}
