/**
 * Type definitions for the LLM Client module.
 *
 * This module provides type exports from OpenAI SDK and custom interfaces
 * for the ohbaby-agent LLM client system.
 *
 * Design Principles:
 * - DRY: Re-export OpenAI types instead of duplicating them
 * - KISS: Keep interface definitions simple and focused
 * - SRP: Each type has a single, well-defined purpose
 */

import type {
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
import type { CompletionUsage } from 'openai/resources/completions';
import type { OpenAI } from 'openai';

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
 * Re-export token usage statistics type from OpenAI SDK.
 *
 * Contains:
 * - prompt_tokens: Number of tokens in the prompt
 * - completion_tokens: Number of tokens generated
 * - total_tokens: Sum of prompt and completion tokens
 */
export type TokenUsage = CompletionUsage;

/**
 * Finish reason for chat completion.
 *
 * Indicates why the model stopped generating tokens:
 * - 'stop': Model hit a stop sequence or natural stopping point
 * - 'tool_calls': Model called one or more tools
 * - 'length': Max tokens reached
 * - 'content_filter': Output was filtered by content policy
 */
export type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

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
 * Single Responsibility: Encapsulates the OpenAI SDK client and configuration.
 * Configuration is immutable after creation to ensure consistency.
 *
 * Design decision: Configuration is owned by the client instance,
 * not passed separately on each call. This follows the principle of
 * cohesion - related data stays together.
 *
 * Note: apiKey is intentionally excluded from config for security reasons.
 * It is only used internally by the OpenAI client.
 */
export interface LLMClientInstance {
  /** OpenAI SDK client instance */
  client: OpenAI;

  /** Immutable configuration for this LLM client */
  config: {
    /** LLM provider identifier (e.g., 'openai', 'zhipu') */
    provider: string;

    /** Model identifier (e.g., 'gpt-4', 'gpt-4-turbo') */
    model: string;

    /** API base URL */
    baseUrl: string;

    /** Sampling temperature (0-2). Higher = more random */
    temperature: number;

    /** Maximum tokens to generate */
    maxTokens: number;
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

