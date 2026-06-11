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
  TokenUsage,
} from "./types.js";

interface AccumulatedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function buildCompleteMessage(
  accumulatedContent: string,
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ChatCompletionMessageParam {
  if (accumulatedToolCalls.size > 0) {
    const toolCalls = Array.from(accumulatedToolCalls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);

    return {
      role: "assistant",
      content: accumulatedContent === "" ? null : accumulatedContent,
      tool_calls: toolCalls,
    };
  }

  return {
    role: "assistant",
    content:
      accumulatedContent === "" ? "(Empty response)" : accumulatedContent,
  };
}

function parseToolCalls(
  accumulatedToolCalls: Map<number, AccumulatedToolCall>,
): ParsedToolCall[] {
  return Array.from(accumulatedToolCalls.values()).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
  }));
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
 *     console.log('Tokens:', response.tokenUsage?.total_tokens);
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
    signal?: AbortSignal;
    tools?: ChatCompletionCreateParams["tools"];
    maxTokens?: number;
  },
): AsyncGenerator<StreamingResponse, void, unknown> {
  const { provider, config } = llmClient;
  const { signal, tools, maxTokens } = options ?? {};
  const requestMaxTokens =
    validateRequestMaxTokens(maxTokens) ?? config.maxTokens;

  // Accumulation state - maintained across iterations
  let accumulatedContent = "";
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
    });

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

      // Accumulate text content
      if (event.textDelta) {
        accumulatedContent += event.textDelta;
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
      yield {
        completeMessage,
        parsedToolCalls,
        isComplete: finishReason !== null,
        finishReason: finishReason ?? undefined,
        rawFinishReason,
        tokenUsage: tokenUsage ?? undefined,
      };
    }
  } catch (error) {
    // Handle user-initiated interruption
    if (provider.isAbortError(error)) {
      // Build final message with accumulated content
      const completeMessage: ChatCompletionMessageParam =
        accumulatedToolCalls.size > 0
          ? {
              role: "assistant",
              content: accumulatedContent === "" ? null : accumulatedContent,
              tool_calls: Array.from(accumulatedToolCalls.values()),
            }
          : {
              role: "assistant",
              content:
                accumulatedContent === ""
                  ? "(Interrupted)"
                  : accumulatedContent,
            };

      // Return partial results instead of throwing
      // This allows consumers to save or reuse the partial response
      yield {
        completeMessage,
        isComplete: true,
        finishReason: "length", // Use 'length' as marker for interruption
        rawFinishReason,
        tokenUsage: tokenUsage ?? undefined,
      };

      return;
    }

    // Re-throw other errors (network, auth, API errors)
    throw error;
  }
}
