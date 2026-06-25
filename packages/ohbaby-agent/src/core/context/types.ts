import type { BusInstance } from "../../bus/index.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageManager, MessageWithParts } from "../message/index.js";

export interface MemoryReader {
  load(directory: string): Promise<MergedMemory>;
}

export interface SystemPromptProvider {
  build(input: {
    readonly sessionId: string;
    readonly directory: string;
    readonly isSubagent: boolean;
  }): Promise<string>;
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
    readonly prompt: string;
    readonly systemPrompt?: string;
    readonly history: readonly MessageWithParts[];
  }): Promise<string>;
}

export interface AssembledContext {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly hasSummary: boolean;
  readonly assembledAt: number;
  readonly sessionId: string;
  readonly isSubagent: boolean;
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

export interface CompressionResult {
  readonly status: CompressionStatus;
  readonly originalTokens: number;
  readonly newTokens: number;
  readonly savedTokens: number;
  readonly summaryMessageId?: string;
  readonly error?: string;
}

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
  readonly directory: string;
  readonly force?: boolean;
  readonly isSubagent?: boolean;
  readonly modelId: string;
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
  readonly directory: string;
  readonly modelId: string;
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly isSubagent?: boolean;
  readonly force?: boolean;
}

export interface PreparedTurn {
  readonly messages: readonly ChatCompletionMessage[];
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
    isSubagent?: boolean,
  ): Promise<AssembledContext>;
  getUsage(context: AssembledContext, modelId: string): ContextUsage;
  updateCalibrationFactor(
    sessionId: string,
    realPromptTokens: number,
    sentHeuristic: number,
  ): void;
  compact(sessionId: string, options: CompactOptions): Promise<CompactResult>;
  prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn>;
}

export interface ContextManagerOptions {
  readonly bus: BusInstance;
  readonly memory: MemoryReader;
  readonly messageManager: MessageManager;
  readonly systemPromptProvider: SystemPromptProvider;
  readonly tokenCounter: TokenCounter;
  readonly llmClient: ContextLLMClient;
  readonly now?: () => number;
  readonly compressionThreshold?: number;
  readonly compressionPreserveRatio?: number;
  readonly pruneProtectTokens?: number;
  readonly pruneMinimumTokens?: number;
  readonly summaryAgentName?: string;
  readonly maskEnabled?: boolean;
  readonly maskConfig?: {
    readonly exemptToolPrefixes?: readonly string[];
    readonly minPartTokens?: number;
    readonly minPrunableTokens?: number;
    readonly minUsageRatio?: number;
    readonly placeholderPrefix?: string;
    readonly protectionTokens?: number;
  };
  readonly onWarning?: (message: string, error?: unknown) => void;
}
