import OpenAI, { APIUserAbortError } from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import type {
  CreateProviderOptions,
  ProviderFinishReason,
  ProviderInstance,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderTokenUsage,
} from "./types.js";

function mapFinishReason(
  finishReason: ChatCompletionChunk.Choice["finish_reason"] | null | undefined,
): ProviderFinishReason | undefined {
  switch (finishReason) {
    case null:
    case undefined:
      return undefined;
    case "function_call":
      return "tool_calls";
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return finishReason;
    default:
      return undefined;
  }
}

function normalizeTokenUsage(
  usage: ChatCompletionChunk["usage"] | undefined | null,
): ProviderTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

function buildRequestParams(
  request: ProviderRequest,
): ChatCompletionCreateParamsStreaming {
  const params: ChatCompletionCreateParamsStreaming = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  if ((request.tools?.length ?? 0) > 0) {
    params.tools = request.tools;
  }

  return params;
}

function buildStreamEvent(
  chunk: ChatCompletionChunk,
): ProviderStreamEvent | null {
  if (chunk.choices.length === 0) {
    const tokenUsage = normalizeTokenUsage(chunk.usage);
    return tokenUsage ? { tokenUsage } : null;
  }

  const choice = chunk.choices[0];
  const mappedToolCallDeltas = choice.delta.tool_calls?.map((toolCall) => ({
    index: toolCall.index,
    id: toolCall.id,
    name: toolCall.function?.name,
    argumentsDelta: toolCall.function?.arguments,
  }));
  const toolCallDeltas =
    mappedToolCallDeltas && mappedToolCallDeltas.length > 0
      ? mappedToolCallDeltas
      : undefined;
  const event: ProviderStreamEvent = {
    textDelta: choice.delta.content ?? undefined,
    toolCallDeltas,
    finishReason: mapFinishReason(choice.finish_reason),
    rawFinishReason: choice.finish_reason ?? undefined,
    tokenUsage: normalizeTokenUsage(chunk.usage),
  };

  if (
    !event.textDelta &&
    (!event.toolCallDeltas || event.toolCallDeltas.length === 0) &&
    !event.finishReason &&
    !event.tokenUsage
  ) {
    return null;
  }

  return event;
}

function isUsageOnlyEvent(event: ProviderStreamEvent): boolean {
  return (
    event.tokenUsage !== undefined &&
    event.textDelta === undefined &&
    event.finishReason === undefined &&
    event.rawFinishReason === undefined &&
    (event.toolCallDeltas === undefined || event.toolCallDeltas.length === 0)
  );
}

export function createOpenAICompatibleProvider(
  options: CreateProviderOptions,
): ProviderInstance<OpenAI> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });

  return {
    id: options.provider,
    kind: "openai-compatible",
    client,
    async streamChatCompletion(
      request: ProviderRequest,
    ): Promise<AsyncIterable<ProviderStreamEvent>> {
      const stream = await client.chat.completions.create(
        buildRequestParams(request),
        {
          signal: request.signal,
        },
      );

      return (async function* (): AsyncGenerator<
        ProviderStreamEvent,
        void,
        unknown
      > {
        let pendingTerminalEvent: ProviderStreamEvent | null = null;

        for await (const chunk of stream) {
          const event = buildStreamEvent(chunk);
          if (event) {
            if (pendingTerminalEvent) {
              if (
                isUsageOnlyEvent(event) &&
                pendingTerminalEvent.tokenUsage === undefined
              ) {
                const terminalEvent: ProviderStreamEvent = pendingTerminalEvent;
                pendingTerminalEvent = {
                  ...terminalEvent,
                  tokenUsage: event.tokenUsage,
                };
                continue;
              }
              yield pendingTerminalEvent;
              pendingTerminalEvent = null;
            }

            if (event.finishReason !== undefined) {
              pendingTerminalEvent = event;
              continue;
            }

            yield event;
          }
        }

        if (pendingTerminalEvent) {
          yield pendingTerminalEvent;
        }
      })();
    },
    isAbortError(error: unknown): boolean {
      return error instanceof APIUserAbortError;
    },
  };
}
