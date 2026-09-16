import { APIConnectionError as OpenAIConnectionError } from "openai";
import { APIConnectionError as AnthropicConnectionError } from "@anthropic-ai/sdk/error";
/**
 * Streaming chat completion with automatic message accumulation.
 *
 * This module provides enhanced streaming that transparently accumulates
 * chat completion responses into complete messages without requiring
 * consumers to manually reconstruct them from chunks.
 *
 * Design Principles:
 * - SRP: Single responsibility - handle stream parsing and accumulation
 * - DRY: Implement message accumulation once, reuse in all consumers
 * - KISS: Simple interface, transparent behavior
 */

import type {
  ModelMessage,
  ModelResponseSnapshot,
  ToolCallSnapshot,
} from "./types.js";
import type {
  LLMClientInstance,
  StreamingResponse,
  ParsedToolCall,
  ModelFinishReason,
  StreamingTokenUsage,
  TokenUsage,
} from "./types.js";
import {
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
  isRetryableProviderError,
  nextRetryDelayMs,
  resolveProviderRetryPolicy,
  retryReason,
  type ProviderRetryPolicy,
} from "./retry.js";
import { ToolCallParseError, isContextOverflowError } from "./errors.js";
import {
  ModelStateSchema,
  NativeOutputSchema,
  validateNativeProjection,
  type NativeOutput,
} from "../../services/interface-providers/native-state.js";
import {
  resolveRequestReasoning,
  type ReasoningIntent,
} from "../../services/interface-providers/reasoning.js";
import type { ReasoningConfig } from "../../config/llm/types.js";
import { resolvePromptCacheRequest } from "./prompt-cache.js";
import type {
  ModelToolDefinition,
  LLMRequestPurpose,
} from "../../services/interface-providers/index.js";

interface AccumulatedToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

function toStreamingTokenUsage(usage: TokenUsage): StreamingTokenUsage {
  return {
    ...(usage.inputBreakdown === undefined
      ? {}
      : { inputBreakdown: usage.inputBreakdown }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

class RetrySleepAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super("Retry sleep aborted");
    this.name = "RetrySleepAbortedError";
  }
}

function sortedToolCalls(
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ToolCallSnapshot[] {
  return Array.from(accumulatedToolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      index,
      callId: call.callId,
      name: call.name,
      argumentsJson: call.argumentsJson,
    }));
}

function buildCompleteMessage(
  accumulatedContent: string,
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ModelResponseSnapshot {
  if (accumulatedToolCalls.size > 0) {
    return {
      content: accumulatedContent === "" ? null : accumulatedContent,
      toolCalls: sortedToolCalls(accumulatedToolCalls),
    };
  }

  return {
    content: accumulatedContent === "" ? null : accumulatedContent,
  };
}

function buildAbortResponse(input: {
  readonly accumulatedContent: string;
  readonly accumulatedReasoning: string;
  readonly accumulatedToolCalls: Map<number, AccumulatedToolCall>;
  readonly rawFinishReason: string | undefined;
  readonly tokenUsage: TokenUsage | null;
}): StreamingResponse {
  const messageSnapshot: ModelResponseSnapshot =
    input.accumulatedToolCalls.size > 0
      ? {
          content:
            input.accumulatedContent === "" ? null : input.accumulatedContent,
          toolCalls: sortedToolCalls(input.accumulatedToolCalls),
        }
      : {
          content:
            input.accumulatedContent === "" ? null : input.accumulatedContent,
        };

  return {
    messageSnapshot,
    isComplete: true,
    rawFinishReason: input.rawFinishReason,
    reasoningText:
      input.accumulatedReasoning === ""
        ? undefined
        : input.accumulatedReasoning,
    streamStopReason: "user_aborted",
    tokenUsage:
      input.tokenUsage === null
        ? undefined
        : toStreamingTokenUsage(input.tokenUsage),
  };
}

function isUsageOnlyEvent(event: {
  readonly finishReason?: ModelFinishReason;
  readonly rawFinishReason?: string;
  readonly reasoningTextDelta?: string;
  readonly textDelta?: string;
  readonly tokenUsage?: TokenUsage;
  readonly toolCallDeltas?: readonly unknown[];
}): boolean {
  return (
    event.tokenUsage !== undefined &&
    event.textDelta === undefined &&
    event.reasoningTextDelta === undefined &&
    event.finishReason === undefined &&
    event.rawFinishReason === undefined &&
    (event.toolCallDeltas === undefined || event.toolCallDeltas.length === 0)
  );
}

function parseToolCalls(
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ParsedToolCall[] {
  return Array.from(accumulatedToolCalls.values()).map((call) => {
    try {
      return {
        callId: call.callId,
        name: call.name,
        arguments: JSON.parse(call.argumentsJson) as Record<string, unknown>,
      };
    } catch (error) {
      throw new ToolCallParseError(call.name, error);
    }
  });
}

function validateRequestMaxTokens(
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `Invalid maxTokens: ${String(value)}. Must be a positive integer`,
    );
  }
  return value;
}

/**
 * Stream chat completion and accumulate complete messages in real-time.
 *
 * This function solves the problem of having to manually reconstruct messages
 * from streaming chunks. It provides:
 * - Always-available complete messages for UI rendering and storage
 * - Automatic tool call parameter accumulation
 * - Proper error handling for user interruptions
 * - Token usage statistics when available
 *
 * Single Responsibility: Handle the mechanics of streaming parsing and
 * accumulation. Does not make decisions about what to do with the data.
 *
 * Design Decision - Two-Phase Tool Call Handling:
 * 1. Flow Phase: As chunks arrive, tool calls are accumulated but not parsed
 * 2. Complete Phase: When stream ends, tool call arguments are JSON-parsed
 *
 * Rationale: Tool call arguments come as fragments of JSON. Parsing before
 * they're complete would throw errors. Only parse when we have the complete
 * arguments (finishReason is not null).
 *
 * Design Decision - Partial Results on Interruption:
 * When user aborts with AbortSignal, we:
 * 1. Catch APIUserAbortError
 * 2. Return accumulated content as a final response
 * 3. Mark the response as complete but don't throw
 *
 * Rationale: Content is not wasted. Users see "partial response" instead of
 * "error". Consumers can decide whether to save or retry.
 *
 * @param {LLMClientInstance} llmClient - Client instance with SDK and config
 * @param {ModelMessage[]} messages - Message history for context
 * @param {Object} [options] - Optional parameters
 * @param {AbortSignal} [options.signal] - Signal to interrupt streaming
 * @param {ModelToolDefinition[]} [options.tools] - Tool definitions
 * @param {number} [options.maxTokens] - Per-request output cap; overrides
 *   config.maxTokens for this call only. Never mutate (or copy-and-replace)
 *   the shared client config to express a per-call limit.
 *
 * @returns {AsyncGenerator<StreamingResponse>} Yields responses as they stream
 *
 * @throws {Error} - Provider-specific abort errors are converted into partial results
 * @throws {APIError} - Network, authentication, or API errors
 * @throws {Error} - Other unexpected errors during streaming
 *
 * @example
 * ```typescript
 * const llmClient = createLLMClient();
 * const messages = [{ role: 'user', content: 'Hello' }];
 *
 * for await (const response of streamResponse(llmClient, messages)) {
 *   console.log(response.messageSnapshot.content); // Real-time display
 *
 *   if (response.isComplete) {
 *     console.log('Tokens:', response.tokenUsage?.totalTokens);
 *     if (response.parsedToolCalls) {
 *       // Handle tool calls
 *     }
 *   }
 * }
 * ```
 */
export async function* streamResponse(
  llmClient: LLMClientInstance,
  messages: readonly ModelMessage[],
  options?: {
    retry?: Partial<ProviderRetryPolicy>;
    signal?: AbortSignal;
    tools?: readonly ModelToolDefinition[];
    maxTokens?: number;
    purpose?: LLMRequestPurpose;
    sessionId?: string;
    contextScopeId?: string;
    reasoning?: ReasoningConfig | ReasoningIntent;
  },
): AsyncGenerator<StreamingResponse, void, unknown> {
  const { provider, config } = llmClient;
  const {
    retry,
    signal,
    tools,
    maxTokens,
    purpose,
    sessionId,
    contextScopeId,
  } = options ?? {};
  const retryPolicy = resolveProviderRetryPolicy(retry);
  const requestMaxTokens =
    validateRequestMaxTokens(maxTokens) ?? config.maxTokens;
  const snapshot = options?.reasoning;
  const reasoning = resolveRequestReasoning({
    ...config,
    maxTokens: requestMaxTokens,
    ...(snapshot && "explicit" in snapshot
      ? { reasoning: snapshot }
      : { override: snapshot }),
    purpose,
  });
  const promptCache = resolvePromptCacheRequest({
    baseUrl: config.baseUrl,
    interfaceProvider: config.interfaceProvider,
    policy: config.promptCache ?? "auto",
    provider: config.provider,
    messages,
    ...(purpose === undefined ? {} : { purpose }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
  });

  let failedAttempts = 0;

  for (;;) {
    // Every provider retry is a new attempt. Keeping this state inside the
    // loop prevents usage, reasoning, finish state, and partial tool calls
    // from a failed attempt leaking into the replacement stream.
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    const accumulatedToolCalls = new Map<number, AccumulatedToolCall>();
    let finishReason: ModelFinishReason | null = null;
    let rawFinishReason: string | undefined;
    let tokenUsage: TokenUsage | null = null;
    let nativeOutput: NativeOutput | undefined;
    let reasoningTokens: number | undefined;
    let validatingProtocol = false;

    try {
      const stream = await provider.streamResponse({
        model: config.model,
        messages,
        temperature: config.temperature,
        reasoning,
        maxTokens: requestMaxTokens,
        tools,
        signal,
        ...(purpose === undefined ? {} : { purpose }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(contextScopeId === undefined ? {} : { contextScopeId }),
        promptCache,
      });

      // Stream each normalized event from the provider
      for await (const event of stream) {
        const finish = event.finishReason;
        if (event.nativeOutput !== undefined) {
          validatingProtocol = true;
          nativeOutput = NativeOutputSchema.parse(event.nativeOutput);
          validatingProtocol = false;
        }
        if (event.reasoningTokens !== undefined)
          reasoningTokens = event.reasoningTokens;

        // Update finish reason when stream ends
        if (finish) {
          finishReason = finish;
        }
        if (event.rawFinishReason) {
          rawFinishReason = event.rawFinishReason;
        }

        // Capture token usage (typically only in last chunk)
        if (event.tokenUsage) {
          tokenUsage = event.tokenUsage;
        }

        // Anthropic reports cache accounting in message_start. Retain it for
        // the eventual terminal response, but do not expose an attempt-local
        // usage-only frame that may later be discarded by a safe retry.
        if (isUsageOnlyEvent(event)) {
          continue;
        }

        // Accumulate text content
        if (event.textDelta) {
          accumulatedContent += event.textDelta;
        }

        if (event.reasoningTextDelta) {
          accumulatedReasoning += event.reasoningTextDelta;
        }

        // Accumulate tool call fragments
        if (event.toolCallDeltas) {
          for (const toolCall of event.toolCallDeltas) {
            const index = toolCall.index;

            // Create new tool call entry if first fragment
            if (!accumulatedToolCalls.has(index)) {
              accumulatedToolCalls.set(index, {
                callId: toolCall.id ?? "",
                name: toolCall.name ?? "",
                argumentsJson: "",
              });
            }

            // Accumulate fragments into the tool call
            const accumulated = accumulatedToolCalls.get(index);
            if (!accumulated) {
              continue;
            }

            if (toolCall.id) {
              accumulated.callId = toolCall.id;
            }
            if (toolCall.name) {
              accumulated.name = toolCall.name;
            }
            if (toolCall.argumentsDelta) {
              accumulated.argumentsJson += toolCall.argumentsDelta;
            }
          }
        }

        // Build complete message from accumulated state
        const messageSnapshot = buildCompleteMessage(
          accumulatedContent,
          accumulatedToolCalls,
        );

        // Parsing and replay publication require successful stream exhaustion.
        yield {
          messageSnapshot,
          isComplete: false,
          finishReason: finishReason ?? undefined,
          reasoningText:
            accumulatedReasoning === "" ? undefined : accumulatedReasoning,
          reasoningTextDelta: event.reasoningTextDelta,
          rawFinishReason,
          tokenUsage:
            tokenUsage === null ? undefined : toStreamingTokenUsage(tokenUsage),
        };
      }
      if (signal?.aborted) {
        yield buildAbortResponse({
          accumulatedContent,
          accumulatedReasoning,
          accumulatedToolCalls,
          rawFinishReason,
          tokenUsage,
        });
        return;
      }
      if (finishReason === null) {
        throw new ProviderStreamInterruptedError(
          new Error("Provider stream ended without a terminal event"),
          "eof",
        );
      }
      validatingProtocol = true;
      const parsedToolCalls =
        finishReason !== "length" &&
        finishReason !== "content_filter" &&
        accumulatedToolCalls.size > 0
          ? parseToolCalls(accumulatedToolCalls)
          : undefined;
      const messageSnapshot = buildCompleteMessage(
        accumulatedContent,
        accumulatedToolCalls,
      );
      const modelState =
        nativeOutput &&
        finishReason !== "length" &&
        finishReason !== "content_filter"
          ? ModelStateSchema.parse({
              version: 1,
              origin: {
                provider: config.provider,
                model: config.model,
                protocol: config.interfaceProvider,
                endpoint: config.baseUrl,
              },
              output: nativeOutput,
              estimate:
                reasoningTokens !== undefined
                  ? { tokens: reasoningTokens, source: "reasoning" }
                  : tokenUsage !== null
                    ? { tokens: tokenUsage.outputTokens, source: "output" }
                    : { tokens: requestMaxTokens, source: "limit" },
            })
          : undefined;
      if (modelState) {
        validateNativeProjection(
          {
            role: "assistant",
            content: accumulatedContent || null,
            toolCalls: parsedToolCalls?.map((call) => ({
              callId: call.callId,
              name: call.name,
              argumentsJson: JSON.stringify(call.arguments),
            })),
          },
          modelState.output,
        );
      }
      validatingProtocol = false;
      yield {
        messageSnapshot,
        parsedToolCalls,
        modelState,
        isComplete: true,
        finishReason,
        reasoningText: accumulatedReasoning || undefined,
        rawFinishReason,
        streamStopReason: "provider_finished",
        tokenUsage:
          tokenUsage === null ? undefined : toStreamingTokenUsage(tokenUsage),
      };
      return;
    } catch (error) {
      // Malformed tool arguments are a model output defect; surface them
      // as-is so consumers do not mistake them for a transport interruption.
      if (error instanceof ToolCallParseError) {
        throw error;
      }
      // Handle user-initiated interruption
      if (signal?.aborted === true) {
        // Return partial results instead of throwing
        // This allows consumers to save or reuse the partial response
        yield buildAbortResponse({
          accumulatedContent,
          accumulatedReasoning,
          accumulatedToolCalls,
          rawFinishReason,
          tokenUsage,
        });

        return;
      }

      if (provider.isAbortError(error)) {
        throw annotatePromptCacheError(
          new ProviderStreamInterruptedError(error, "provider_abort"),
          promptCache.strategy,
        );
      }
      if (error instanceof ProviderStreamInterruptedError) throw error;
      if (validatingProtocol) {
        throw new ProviderStreamInterruptedError(error, "protocol");
      }

      // Lifecycle owns the single forced-compaction retry, including an
      // overflowing attempt that emitted a provisional completion already.
      // Do not turn that explicit provider error into a transport failure.
      if (isContextOverflowError(error)) throw error;

      if (
        accumulatedContent !== "" ||
        accumulatedReasoning !== "" ||
        accumulatedToolCalls.size > 0 ||
        finishReason !== null ||
        rawFinishReason !== undefined
      ) {
        throw annotatePromptCacheError(
          new ProviderStreamInterruptedError(error, streamFailureSource(error)),
          promptCache.strategy,
        );
      }

      failedAttempts += 1;
      if (
        failedAttempts > retryPolicy.maxRetriesPerStep ||
        !isRetryableProviderError(error)
      ) {
        if (isRetryableProviderError(error)) {
          throw annotatePromptCacheError(
            new ProviderRetryExhaustedError(
              annotatePromptCacheError(error, promptCache.strategy),
              failedAttempts - 1,
            ),
            promptCache.strategy,
          );
        }
        throw annotatePromptCacheError(error, promptCache.strategy);
      }

      const delayMs = nextRetryDelayMs({
        attempt: failedAttempts,
        error,
        policy: retryPolicy,
      });
      // Notify before the backoff sleep so consumers see the retry while it
      // is happening, not after the next attempt succeeds.
      yield {
        messageSnapshot: { content: "" },
        isComplete: false,
        retry: {
          attempt: failedAttempts,
          delayMs,
          maxRetries: retryPolicy.maxRetriesPerStep,
          reason: retryReason(error),
        },
      };
      try {
        await sleepForRetry(delayMs, signal);
      } catch (sleepError) {
        if (sleepError instanceof RetrySleepAbortedError) {
          yield buildAbortResponse({
            accumulatedContent,
            accumulatedReasoning,
            accumulatedToolCalls,
            rawFinishReason,
            tokenUsage,
          });
          return;
        }
        throw sleepError;
      }
    }
  }
}

function annotatePromptCacheError(error: unknown, strategy: string): unknown {
  if (strategy === "observe-only") {
    return error;
  }
  if (!(error instanceof Error)) {
    return new Error(`${String(error)} [prompt-cache strategy=${strategy}]`, {
      cause: error,
    });
  }
  const annotatedMessage = error.message.includes("prompt-cache strategy=")
    ? error.message
    : `${error.message} [prompt-cache strategy=${strategy}]`;
  if (!Object.isExtensible(error)) {
    return new Error(annotatedMessage, { cause: error });
  }
  try {
    error.message = annotatedMessage;
    Object.defineProperty(error, "promptCacheStrategy", {
      configurable: true,
      enumerable: false,
      value: strategy,
    });
    return error;
  } catch {
    return new Error(annotatedMessage, { cause: error });
  }
}

async function sleepForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new RetrySleepAbortedError(signal.reason);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new RetrySleepAbortedError(signal?.reason));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** History may retain known transport failures; this does not expand retries. */
function streamFailureSource(error: unknown): "transport" | undefined {
  if (
    error instanceof OpenAIConnectionError ||
    error instanceof AnthropicConnectionError
  ) {
    return "transport";
  }
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" &&
    [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(error.code.toUpperCase())
    ? "transport"
    : undefined;
}
