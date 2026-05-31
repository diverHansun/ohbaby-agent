/**
 * Type definitions for the LLM Client module.
 *
 * This module provides the public types for the ohbaby-agent LLM client system.
 *
 * Design Principles:
 * - DRY: Re-export OpenAI types instead of duplicating them
 * - KISS: Keep interface definitions simple and focused
 * - SRP: Each type has a single, well-defined purpose
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type {
  InterfaceProviderInstance,
  InterfaceProviderTokenUsage,
} from "../../services/interface-providers/index.js";
import type { LLMConfig } from "../../config/index.js";

/**
 * Re-export OpenAI message type for convenience.
 *
 * Represents a message in the chat completion API, including:
 * - system: System instruction message
 * - user: User message
 * - assistant: Assistant response message
 * - tool: Tool execution result message
 */
export type ChatCompletionMessage = ChatCompletionMessageParam;

/**
 * Re-export normalized token usage statistics from the provider layer.
 *
 * Contains:
 * - prompt_tokens: Number of tokens in the prompt
 * - completion_tokens: Number of tokens generated
 * - total_tokens: Sum of prompt and completion tokens
 */
export type TokenUsage = InterfaceProviderTokenUsage;

/**
 * Finish reason for chat completion.
 *
 * Indicates why the model stopped generating tokens:
 * - 'stop': Model hit a stop sequence or natural stopping point
 * - 'tool_calls': Model called one or more tools
 * - 'length': Max tokens reached
 * - 'content_filter': Output was filtered by content policy
 */
export type ChatFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

/**
 * Parsed tool call with resolved arguments.
 *
 * Single Responsibility: Represents a successfully parsed tool call.
 * The arguments are already JSON-parsed into objects.
 *
 * Constraint: Only populated when stream is complete (finishReason is not null)
 * to ensure arguments are fully accumulated before parsing.
 */
export interface ParsedToolCall {
  /** Unique identifier for this tool call */
  id: string;

  /** Name of the tool/function to invoke */
  name: string;

  /** Parsed arguments as an object (JSON already parsed) */
  arguments: Record<string, unknown>;
}

/**
 * LLM Client instance.
 *
 * Single Responsibility: Encapsulates the provider instance and configuration.
 * Configuration is immutable after creation to ensure consistency.
 *
 * Design decision: Configuration is owned by the client instance,
 * not passed separately on each call. This follows the principle of
 * cohesion - related data stays together.
 *
 * Note: apiKey is intentionally excluded from config for security reasons.
 * It is only used internally by the provider client.
 */
export interface LLMClientInstance<TClient = unknown> {
  /** Provider adapter used by the streaming core */
  provider: InterfaceProviderInstance<TClient>;

  /** Immutable configuration for this LLM client */
  config: {
    /** LLM provider identifier (e.g., 'openai', 'zhipu') */
    provider: string;

    /** Model identifier (e.g., 'gpt-4', 'gpt-4-turbo') */
    model: string;

    /** Environment variable name used for the API key */
    apiKeyEnv: string;

    /** API base URL */
    baseUrl: string;

    /** API protocol adapter used by the runtime client */
    interfaceProvider: LLMConfig["interfaceProvider"];

    /** Sampling temperature (0-2). Higher = more random */
    temperature: number;

    /** Maximum tokens to generate */
    maxTokens: number;

    /** Full model context window used for local compaction decisions */
    contextWindowTokens?: number;

    /** User-registered model profiles used for local token budgeting */
    modelProfiles?: LLMConfig["modelProfiles"];
  };
}

/**
 * Response from streaming chat completion.
 *
 * Single Responsibility: Represents one chunk of a streaming response.
 * Consumers receive this object on each iteration of the async generator.
 *
 * Design decision: Include both partial and complete information in each yield.
 * - completeMessage: Always available, updated with each chunk
 * - parsedToolCalls: Only when stream is complete
 * - isComplete, finishReason, tokenUsage: Only when stream is complete
 *
 * This allows consumers to:
 * 1. Display streaming content in real-time
 * 2. Know when streaming is complete
 * 3. Access parsed tool calls only when they're valid
 */
export interface StreamingResponse {
  /**
   * Complete message accumulated so far.
   *
   * Always contains the full content/tool_calls up to this point.
   * Consumers can use this directly for storage or display.
   *
   * Content: Text accumulated from all chunks
   * Tool calls: Tool calls with arguments accumulated so far
   */
  completeMessage: ChatCompletionMessage;

  /**
   * Parsed tool calls with resolved arguments.
   *
   * Only populated when:
   * 1. The stream is complete (isComplete === true)
   * 2. The model called tools (finish_reason === 'tool_calls')
   *
   * Arguments are guaranteed to be valid JSON objects.
   *
   * Rationale: Avoid partial JSON parsing which could throw errors.
   * Only parse when arguments are guaranteed to be complete.
   */
  parsedToolCalls?: ParsedToolCall[];

  /**
   * Whether the stream has completed.
   *
   * When true, finishReason and tokenUsage are populated.
   * This is the final response for this request.
   */
  isComplete: boolean;

  /**
   * Reason the stream completed.
   *
   * Only populated when isComplete === true.
   * Guides consumer logic for what to do with the response.
   */
  finishReason?: ChatFinishReason;

  /**
   * Provider-specific raw finish reason before normalization.
   *
   * Example: Anthropic may emit `pause_turn`, which is normalized to `stop`
   * for the shared finish-reason enum while still being exposed here.
   */
  rawFinishReason?: string;

  /**
   * Token usage statistics for the complete request.
   *
   * Only populated when isComplete === true.
   * Contains prompt_tokens, completion_tokens, total_tokens.
   *
   * Note: May not be present if stream was interrupted by user.
   */
  tokenUsage?: TokenUsage;
}

/**
 * OpenAI tool definition for function calling.
 *
 * Re-export for convenience when passing tools to streamChatCompletion.
 * Consumers can import from openai or use the types from this module.
 */
