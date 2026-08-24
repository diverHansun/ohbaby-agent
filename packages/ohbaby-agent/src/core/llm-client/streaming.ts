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
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources";
import type {
  LLMClientInstance,
  StreamingResponse,
  ParsedToolCall,
  ChatFinishReason,
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
import { ToolCallParseError } from "./errors.js";
import { resolvePromptCacheRequest } from "./prompt-cache.js";
import type { LLMRequestPurpose } from "../../services/interface-providers/index.js";

interface AccumulatedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function withLegacyTokenUsageAliases(usage: TokenUsage): StreamingTokenUsage {
  const publicUsage = {
    ...(usage.inputBreakdown === undefined
      ? {}
      : { inputBreakdown: usage.inputBreakdown }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  } as StreamingTokenUsage;

  Object.defineProperties(publicUsage, {
    completion_tokens: { enumerable: false, value: usage.outputTokens },
    prompt_tokens: { enumerable: false, value: usage.inputTokens },
    total_tokens: { enumerable: false, value: usage.totalTokens },
  });
  return publicUsage;
}

class RetrySleepAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super("Retry sleep aborted");
    this.name = "RetrySleepAbortedError";
  }
}

function sortedToolCalls(
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): AccumulatedToolCall[] {
  return Array.from(accumulatedToolCalls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call);
}

function buildCompleteMessage(
  accumulatedContent: string,
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ChatCompletionMessageParam {
  if (accumulatedToolCalls.size > 0) {
    return {
      role: "assistant",
      content: accumulatedContent === "" ? null : accumulatedContent,
      tool_calls: sortedToolCalls(accumulatedToolCalls),
    };
  }

  return {
    role: "assistant",
    content:
      accumulatedContent === "" ? "(Empty response)" : accumulatedContent,
  };
}

function buildAbortResponse(input: {
  readonly accumulatedContent: string;
  readonly accumulatedReasoning: string;
  readonly accumulatedToolCalls: Map<number, AccumulatedToolCall>;
  readonly rawFinishReason: string | undefined;
  readonly tokenUsage: TokenUsage | null;
}): StreamingResponse {
  const completeMessage: ChatCompletionMessageParam =
    input.accumulatedToolCalls.size > 0
      ? {
          role: "assistant",
          content:
            input.accumulatedContent === "" ? null : input.accumulatedContent,
          tool_calls: sortedToolCalls(input.accumulatedToolCalls),
        }
      : {
          role: "assistant",
          content:
            input.accumulatedContent === ""
              ? "(Interrupted)"
              : input.accumulatedContent,
        };

  return {
    completeMessage,
    isComplete: true,
    rawFinishReason: input.rawFinishReason,
    reasoning:
      input.accumulatedReasoning === ""
        ? undefined
        : input.accumulatedReasoning,
    streamStopReason: "user_aborted",
    tokenUsage:
      input.tokenUsage === null
        ? undefined
        : withLegacyTokenUsageAliases(input.tokenUsage),
  };
}

function isUsageOnlyEvent(event: {
  readonly finishReason?: ChatFinishReason;
  readonly rawFinishReason?: string;
  readonly reasoningDelta?: string;
  readonly textDelta?: string;
  readonly tokenUsage?: TokenUsage;
  readonly toolCallDeltas?: readonly unknown[];
}): boolean {
  return (
    event.tokenUsage !== undefined &&
    event.textDelta === undefined &&
    event.reasoningDelta === undefined &&
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
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as Record<
          string,
          unknown
        >,
      };
    } catch (error) {
      throw new ToolCallParseError(call.function.name, error);
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
 * @param {ChatCompletionMessage[]} messages - Message history for context
 * @param {Object} [options] - Optional parameters
 * @param {AbortSignal} [options.signal] - Signal to interrupt streaming
 * @param {ChatCompletionCreateParams['tools']} [options.tools] - Tool definitions
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
 * for await (const response of streamChatCompletion(llmClient, messages)) {
 *   console.log(response.completeMessage.content); // Real-time display
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
export async function* streamChatCompletion(
  llmClient: LLMClientInstance,
  messages: ChatCompletionMessageParam[],
  options?: {
    retry?: Partial<ProviderRetryPolicy>;
    signal?: AbortSignal;
    tools?: ChatCompletionCreateParams["tools"];
    maxTokens?: number;
    purpose?: LLMRequestPurpose;
    sessionId?: string;
    contextScopeId?: string;
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
    let finishReason: ChatFinishReason | null = null;
    let rawFinishReason: string | undefined;
    let tokenUsage: TokenUsage | null = null;

    try {
      const stream = await provider.streamChatCompletion({
        model: config.model,
        messages,
        temperature: config.temperature,
        maxTokens: requestMaxTokens,
        tools,
        signal,
        ...(purpose === undefined ? {} : { purpose }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(contextScopeId === undefined ? {} : { contextScopeId }),
        promptCache,
      });

      let emittedAnyResponse = false;
      // Stream each normalized event from the provider
      for await (const event of stream) {
        const finish = event.finishReason;

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

        if (event.reasoningDelta) {
          accumulatedReasoning += event.reasoningDelta;
        }

        // Accumulate tool call fragments
        if (event.toolCallDeltas) {
          for (const toolCall of event.toolCallDeltas) {
            const index = toolCall.index;

            // Create new tool call entry if first fragment
            if (!accumulatedToolCalls.has(index)) {
              accumulatedToolCalls.set(index, {
                id: toolCall.id ?? "",
                type: "function",
                function: {
                  name: toolCall.name ?? "",
                  arguments: "",
                },
              });
            }

            // Accumulate fragments into the tool call
            const accumulated = accumulatedToolCalls.get(index);
            if (!accumulated) {
              continue;
            }

            if (toolCall.id) {
              accumulated.id = toolCall.id;
            }
            if (toolCall.name) {
              accumulated.function.name = toolCall.name;
            }
            if (toolCall.argumentsDelta) {
              accumulated.function.arguments += toolCall.argumentsDelta;
            }
          }
        }

        // Build complete message from accumulated state
        const completeMessage = buildCompleteMessage(
          accumulatedContent,
          accumulatedToolCalls,
        );

        // Parse tool calls only when stream is complete
        let parsedToolCalls: ParsedToolCall[] | undefined;
        if (finishReason && accumulatedToolCalls.size > 0) {
          parsedToolCalls = parseToolCalls(accumulatedToolCalls);
        }

        // Yield response with accumulated data
        emittedAnyResponse = true;
        yield {
          completeMessage,
          parsedToolCalls,
          isComplete: finishReason !== null,
          finishReason: finishReason ?? undefined,
          reasoning:
            accumulatedReasoning === "" ? undefined : accumulatedReasoning,
          reasoningDelta: event.reasoningDelta,
          rawFinishReason,
          streamStopReason:
            finishReason === null ? undefined : "provider_finished",
          tokenUsage:
            tokenUsage === null
              ? undefined
              : withLegacyTokenUsageAliases(tokenUsage),
        };
      }
      if (!emittedAnyResponse) {
        yield {
          completeMessage: buildCompleteMessage(
            accumulatedContent,
            accumulatedToolCalls,
          ),
          isComplete: true,
          reasoning:
            accumulatedReasoning === "" ? undefined : accumulatedReasoning,
          rawFinishReason,
          streamStopReason: "provider_finished",
          tokenUsage:
            tokenUsage === null
              ? undefined
              : withLegacyTokenUsageAliases(tokenUsage),
        };
      }
      return;
    } catch (error) {
      // Malformed tool arguments are a model output defect; surface them
      // as-is so consumers do not mistake them for a transport interruption.
      if (error instanceof ToolCallParseError) {
        throw error;
      }
      // Handle user-initiated interruption
      if (
        provider.isAbortError(error) ||
        error instanceof RetrySleepAbortedError ||
        signal?.aborted === true
      ) {
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

      if (
        accumulatedContent !== "" ||
        accumulatedReasoning !== "" ||
        accumulatedToolCalls.size > 0 ||
        finishReason !== null ||
        rawFinishReason !== undefined
      ) {
        throw annotatePromptCacheError(
          new ProviderStreamInterruptedError(error),
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
        completeMessage: { role: "assistant", content: "" },
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
