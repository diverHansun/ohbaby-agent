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

import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources';
import { APIUserAbortError } from 'openai';
import type {
  LLMClientInstance,
  StreamingResponse,
  ParsedToolCall,
  ChatFinishReason,
} from './types.js';

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
 *
 * @returns {AsyncGenerator<StreamingResponse>} Yields responses as they stream
 *
 * @throws {APIUserAbortError} - Only if signal is aborted before first chunk
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
    tools?: ChatCompletionCreateParams['tools'];
  }
): AsyncGenerator<StreamingResponse, void, unknown> {
  const { client, config } = llmClient;
  const { signal, tools } = options ?? {};

  // Build request parameters
  const params: ChatCompletionCreateParams = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
    // Request token usage in the stream
    // Note: Requires OpenAI API to support stream_options parameter
    stream_options: { include_usage: true },
  };

  // Add tools if provided
  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  // Initiate streaming request
  const stream = await client.chat.completions.create(params, { signal });

  // Accumulation state - maintained across iterations
  let accumulatedContent = '';
  const accumulatedToolCalls = new Map<number, any>();
  let finishReason: ChatFinishReason | null = null;
  let tokenUsage: any = null;

  try {
    // Stream each chunk from the API
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const finish = chunk.choices?.[0]?.finish_reason;

      // Update finish reason when stream ends
      if (finish) {
        finishReason = finish as ChatFinishReason;
      }

      // Capture token usage (typically only in last chunk)
      if (chunk.usage) {
        tokenUsage = {
          prompt_tokens: chunk.usage.prompt_tokens || 0,
          completion_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: chunk.usage.total_tokens || 0,
        };
      }

      // Accumulate text content
      if (delta?.content) {
        accumulatedContent += delta.content;
      }

      // Accumulate tool call fragments
      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;

          // Create new tool call entry if first fragment
          if (!accumulatedToolCalls.has(index)) {
            accumulatedToolCalls.set(index, {
              id: toolCall.id || '',
              type: 'function',
              function: {
                name: toolCall.function?.name || '',
                arguments: '',
              },
            });
          }

          // Accumulate fragments into the tool call
          const accumulated = accumulatedToolCalls.get(index);
          if (toolCall.id) {
            accumulated.id = toolCall.id;
          }
          if (toolCall.function?.name) {
            accumulated.function.name = toolCall.function.name;
          }
          if (toolCall.function?.arguments) {
            accumulated.function.arguments += toolCall.function.arguments;
          }
        }
      }

      // Build complete message from accumulated state
      let completeMessage: ChatCompletionMessageParam;

      if (accumulatedToolCalls.size > 0) {
        // Tool call response
        const toolCalls = Array.from(accumulatedToolCalls.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, call]) => call);

        completeMessage = {
          role: 'assistant',
          content: accumulatedContent || null,
          tool_calls: toolCalls,
        };
      } else {
        // Text-only response
        // Handle empty responses from some LLM providers
        let content = accumulatedContent;
        if (!content) {
          content = '(Empty response)';
        }

        completeMessage = {
          role: 'assistant',
          content,
        };
      }

      // Parse tool calls only when stream is complete
      let parsedToolCalls: ParsedToolCall[] | undefined;
      if (finishReason && accumulatedToolCalls.size > 0) {
        parsedToolCalls = Array.from(accumulatedToolCalls.values()).map((call) => {
          return {
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments),
          };
        });
      }

      // Yield response with accumulated data
      yield {
        completeMessage,
        parsedToolCalls,
        isComplete: finishReason !== null,
        finishReason: finishReason || undefined,
        tokenUsage: tokenUsage || undefined,
      };
    }
  } catch (error) {
    // Handle user-initiated interruption
    if (error instanceof APIUserAbortError) {
      // Build final message with accumulated content
      const completeMessage: ChatCompletionMessageParam =
        accumulatedToolCalls.size > 0
          ? {
              role: 'assistant',
              content: accumulatedContent || null,
              tool_calls: Array.from(accumulatedToolCalls.values()),
            }
          : {
              role: 'assistant',
              content: accumulatedContent || '(Interrupted)',
            };

      // Return partial results instead of throwing
      // This allows consumers to save or reuse the partial response
      yield {
        completeMessage,
        isComplete: true,
        finishReason: 'length', // Use 'length' as marker for interruption
        tokenUsage,
      };

      return;
    }

    // Re-throw other errors (network, auth, API errors)
    throw error;
  }
}
