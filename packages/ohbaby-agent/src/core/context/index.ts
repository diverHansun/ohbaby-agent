import { ContextEvent } from "./events.js";

export {
  COMPRESSION_THRESHOLD,
  KEEP_RECENT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
export { COMPRESSION_PROMPT } from "./compression-prompt.js";
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
export type {
  AssembledContext,
  AgentRunPromptSnapshot,
  CompactOptions,
  CompactResult,
  CompactStatus,
  CompressionResult,
  CompressionSkipReason,
  CompressionStatus,
  ContextAssemblyOptions,
  ContextLLMClient,
  SummaryRequestResult,
  ContextManager,
  ContextManagerOptions,
  ContextOccupancyComposition,
  CreateRunPromptSnapshotInput,
  PreparedModelRequest,
  ContextUsage,
  MemoryReader,
  PreparedTurn,
  PrepareTurnInput,
  SystemPromptProvider,
  SystemPromptProviderInput,
  TokenCounter,
} from "./types.js";

export const Context: { readonly Event: typeof ContextEvent } = {
  Event: ContextEvent,
};
