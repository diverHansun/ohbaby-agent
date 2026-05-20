import { ContextEvent } from "./events.js";

export {
  COMPRESSION_PRESERVE_RATIO,
  COMPRESSION_THRESHOLD,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  SUMMARY_AGENT_NAME,
} from "./constants.js";
export { COMPRESSION_PROMPT } from "./compression-prompt.js";
export { ContextEvent } from "./events.js";
export { createContextManager, getContextUsage } from "./context-manager.js";
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
  PruneResult,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";

export const Context: { readonly Event: typeof ContextEvent } = {
  Event: ContextEvent,
};
