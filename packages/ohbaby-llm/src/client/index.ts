/**
 * Public API for the LLM Client module.
 *
 * This module exports the core functions and types needed to interact
 * with the configured LLM provider through the shared streaming interface.
 *
 * Design Principle: Interface Segregation
 * Consumers import only what they need. The module provides three categories:
 * 1. Functions: createLLMClient, streamResponse
 * 2. Types: LLMClientInstance, StreamingResponse, etc.
 * 3. Error Classes: APIUserAbortError (for convenience)
 */

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  ProviderStreamIdleTimeoutError,
} from "./idle-watchdog.js";

// Export core functions
export { createLLMClientFromConfig } from "./client.js";
export { isContextOverflowError, ToolCallParseError } from "./errors.js";
export {
  DEFAULT_PROVIDER_RETRY_POLICY,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  isRetryableProviderError,
  nextRetryDelayMs,
  parseRetryAfterMs,
  providerErrorStatus,
  retryReason,
} from "./retry.js";
export { streamResponse, resolvePreparedRequestSettings } from "./streaming.js";

// Export type definitions for consumers
export type {
  ModelResponseSnapshot,
  ToolCallSnapshot,
  // Main interfaces
  LLMClientInstance,
  StreamingResponse,
  // Message and token types
  ModelMessage,
  StreamingTokenUsage,
  TokenUsage,
  // Tool-related types
  ParsedToolCall,
  // Metadata types
  ModelFinishReason,
  StreamStopReason,
} from "./types.js";
export type { ProviderRetryEvent, ProviderRetryPolicy } from "./retry.js";
export type {
  ModelToolDefinition,
  ModelToolCall,
  LLMRequestPurpose,
  PromptCacheRequestStrategy,
} from "../providers/index.js";

// Re-export error class for convenience
// Allows consumers to: import { APIUserAbortError } from '@/core/llm-client'
export { APIUserAbortError } from "openai";
