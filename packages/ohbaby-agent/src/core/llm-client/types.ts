/**
 * Type definitions for the LLM Client module.
 *
 * This module provides the public types for the ohbaby-agent LLM client system.
 *
 * Design Principles:
 * - DRY: Re-export the provider-neutral request types
 * - KISS: Keep interface definitions simple and focused
 * - SRP: Each type has a single, well-defined purpose
 */

import type {
  InterfaceProviderInstance,
  InterfaceProviderTokenUsage,
} from "../../services/interface-providers/index.js";
import type { LLMConfig } from "../../config/index.js";
import type { ModelState } from "../../services/interface-providers/native-state.js";
import type { ReasoningIntent } from "../../services/interface-providers/reasoning.js";
import type { ProviderRetryEvent } from "./retry.js";

/**
 * Re-export the owned model request type for convenience.
 *
 * Represents a message in a model request, including:
 * - system/developer: Instruction message
 * - user: User message
 * - assistant: Assistant response message
 * - tool: Tool execution result message
 */
export type { ModelMessage } from "../../services/interface-providers/types.js";

export interface ToolCallSnapshot {
  readonly index: number;
  readonly callId?: string;
  readonly name?: string;
  readonly argumentsJson: string;
}
export interface ModelResponseSnapshot {
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCallSnapshot[];
}

/**
 * Re-export normalized token usage statistics from the provider layer.
 *
 * Contains:
 * - inputTokens: Inclusive provider-reported input tokens
 * - outputTokens: Number of generated tokens
 * - totalTokens: Sum of input and output tokens
 * - inputBreakdown: Optional cache-aware partition of inclusive input tokens
 */
export type TokenUsage = InterfaceProviderTokenUsage;

export type StreamingTokenUsage = TokenUsage;

/**
 * Normalized finish reason reported by the model provider.
 *
 * Indicates why the model stopped generating tokens:
 * - 'stop': Model hit a stop sequence or natural stopping point
 * - 'tool_calls': Model called one or more tools
 * - 'length': Max tokens reached
 * - 'content_filter': Output was filtered by content policy
 */
export type ModelFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

export type StreamStopReason = "provider_finished" | "user_aborted";

/**
 * Parsed tool call with resolved arguments.
 *
 * Single Responsibility: Represents a successfully parsed tool call.
 * The arguments are already JSON-parsed into objects.
 *
 * Populated after a provider finish reason is reported. Parsed arguments do
 * not authorize execution: consumers must wait for successful stream
 * exhaustion and apply the existing tool and permission checks.
 */
export interface ParsedToolCall {
  /** Unique identifier for this tool call */
  callId: string;

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

    /** Optional environment variable name used for the API key */
    apiKeyEnv?: string;

    /** API base URL */
    baseUrl: string;

    /** API protocol adapter used by the runtime client */
    interfaceProvider: LLMConfig["interfaceProvider"];

    /** Prompt-cache request policy resolved from model configuration */
    promptCache?: LLMConfig["promptCache"];

    /** Sampling temperature (0-2). Higher = more random */
    temperature?: number;
    reasoning?: LLMConfig["reasoning"] | ReasoningIntent;

    /** Maximum tokens to generate */
    maxTokens: number;

    /** Full model context window used for local compaction decisions */
    contextWindowTokens?: number;

    /** User-registered model profiles used for local token budgeting */
    modelProfiles?: LLMConfig["modelProfiles"];
  };
}

/**
 * One frame from a streaming model response.
 *
 * Single Responsibility: Represents one chunk of a streaming response.
 * Consumers receive this object on each iteration of the async generator.
 *
 * Design decision: Include both partial and complete information in each yield.
 * - messageSnapshot: Always available, updated with each chunk
 * - parsedToolCalls: Available after a provider finish signal and parsing
 * - isComplete: May also signal interruption, without a finish reason
 * - tokenUsage: Available once reported; may be absent even on completion
 *
 * This allows consumers to:
 * 1. Display streaming content in real-time
 * 2. Know when streaming is complete
 * 3. Inspect parsed tool calls before the execution boundary validates them
 */
export interface StreamingResponse {
  /** Private replay state, available only after normal stream exhaustion. */
  modelState?: ModelState;
  /**
   * Response snapshot accumulated so far.
   *
   * Contains the accumulated text and tool-call fragments for display.
   * A partial snapshot is not a request message or a persisted message.
   *
   * Content: Text accumulated from all chunks
   * Tool calls: Tool calls with arguments accumulated so far
   */
  messageSnapshot: ModelResponseSnapshot;

  /**
   * Parsed tool calls with resolved arguments.
   *
   * Produced after a provider finish reason when accumulated calls can be
   * parsed. A later stream error may still invalidate completion. Neither
   * this field nor the snapshot authorizes tool execution. Abort responses
   * omit parsed calls; successful stream exhaustion and execution checks
   * remain necessary.
   */
  parsedToolCalls?: ParsedToolCall[];

  /**
   * Whether this frame signals provider completion or local interruption.
   * Aborts may have no finishReason or tokenUsage. A later stream error can
   * still invalidate a provider completion signal.
   */
  isComplete: boolean;

  /**
   * Reason the stream completed.
   *
   * Present when a provider finish reason has been received; local aborts
   * need not have one.
   * Guides consumer logic for what to do with the response.
   */
  finishReason?: ModelFinishReason;

  /**
   * Local runtime reason for why streaming stopped.
   *
   * This is intentionally separate from provider finishReason. User aborts
   * and transport interruptions are runtime facts, not model stop reasons.
   */
  streamStopReason?: StreamStopReason;

  /**
   * Provider-specific raw finish reason before normalization.
   *
   * Example: Anthropic may emit `pause_turn`, which is normalized to `stop`
   * for the shared finish-reason enum while still being exposed here.
   */
  rawFinishReason?: string;

  /**
   * Present when this yield is a retry notification, emitted before the
   * backoff sleep so consumers can surface progress in real time instead of
   * appearing stuck. Notification yields carry an empty message and
   * `isComplete: false`; consumers that only read content can ignore them.
   */
  retry?: ProviderRetryEvent;

  /**
   * Reasoning delta emitted by providers that expose a separate thinking
   * channel. This is intentionally separate from assistant text content.
   */
  reasoningTextDelta?: string;

  /**
   * Reasoning accumulated for the current model step. Consumers may use this
   * for live display or same-turn passback, but it must not be treated as
   * assistant message content.
   */
  reasoningText?: string;

  /**
   * Token usage statistics reported so far for this request attempt.
   *
   * May be present on partial frames or absent at completion. Contains
   * canonical inclusive input/output/total token counts and, when the
   * provider reports enough evidence, a cache-aware input breakdown.
   *
   * Note: May not be present if stream was interrupted by user.
   */
  tokenUsage?: StreamingTokenUsage;
}
