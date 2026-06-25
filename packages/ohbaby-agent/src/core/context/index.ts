import { ContextEvent } from "./events.js";

export {
  COMPACTION_MIN_REMAINING_INPUT_TOKENS,
  COMPRESSION_PRESERVE_RATIO,
  COMPRESSION_THRESHOLD,
  KEEP_RECENT_TOKENS,
  MASK_EXEMPT_TOOL_PREFIXES,
  MASK_MIN_PART_TOKENS,
  MASK_MIN_PRUNABLE_TOKENS,
  MASK_MIN_USAGE_RATIO,
  MASK_PLACEHOLDER_PREFIX,
  MASK_PROTECTION_TOKENS,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
export {
  COMPRESSION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./compression-prompt.js";
export { ContextEvent } from "./events.js";
export {
  contextUsageToContextWindowUsage,
  createContextWindowUsageTracker,
} from "./context-window-usage.js";
export type {
  ContextWindowUsageInput,
  ContextWindowUsageTracker,
  ContextWindowUsageTrackerOptions,
} from "./context-window-usage.js";
export {
  createContextManager,
  decideCompactionRung,
  findCutPoint,
  getContextUsage,
} from "./context-manager.js";
export type { CompactionRung, ContextCutPoint } from "./context-manager.js";
export {
  appendMemoryToSystemPrompt,
  loadMemoryForPrompt,
  serializeForLlm,
  serializeHistoryMessages,
} from "./serializer.js";
export {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "./tool-metadata-projection.js";
export { createMaskConfig, reduceForModel } from "./projection.js";
export type {
  ContextMaskedEventPayload,
  MaskConfig,
  MaskSkippedReason,
  ModelReductionResult,
} from "./projection.js";
export type {
  AssembledContext,
  CompactOptions,
  CompactResult,
  CompactStatus,
  CompressionResult,
  CompressionStatus,
  ContextLLMClient,
  ContextManager,
  ContextManagerOptions,
  ContextUsage,
  MemoryReader,
  PreparedTurn,
  PrepareTurnInput,
  PruneResult,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";

export const Context: { readonly Event: typeof ContextEvent } = {
  Event: ContextEvent,
};
