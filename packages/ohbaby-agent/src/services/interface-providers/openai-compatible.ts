import OpenAI, { APIUserAbortError } from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderFinishReason,
  InterfaceProviderInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  ModelMessage,
} from "./types.js";
import { normalizeOpenAICompatibleUsage } from "./token-usage.js";

function mapFinishReason(
  finishReason: ChatCompletionChunk.Choice["finish_reason"] | null | undefined,
): InterfaceProviderFinishReason | undefined {
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function reasoningDeltaFromChoiceDelta(
  delta: ChatCompletionChunk.Choice["delta"],
): string | undefined {
  const extendedDelta = delta as Record<string, unknown>;
  return (
    nonEmptyString(extendedDelta.reasoning_content) ??
    nonEmptyString(extendedDelta.reasoning)
  );
}

function buildRequestParams(
  request: InterfaceProviderRequest,
): ChatCompletionCreateParamsStreaming {
  type PromptCacheWireParams = ChatCompletionCreateParamsStreaming & {
    prompt_cache_key?: string;
  };
  const params: PromptCacheWireParams = {
    model: request.model,
    messages: request.messages.map(projectMessage),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  if ((request.tools?.length ?? 0) > 0) {
    params.tools = request.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  if (request.promptCache.strategy === "openai-keyed-implicit") {
    params.prompt_cache_key = request.promptCache.key;
  }

  return params;
}

function projectMessage(message: ModelMessage): ChatCompletionMessageParam {
  if (
    !["system", "developer", "user", "assistant", "tool"].includes(
      message.role,
    ) ||
    "function_call" in message ||
    "tool_calls" in message ||
    "tool_call_id" in message
  ) {
    throw new Error("Unsupported legacy model message for Chat provider.");
  }
  const content = Array.isArray(message.content)
    ? message.content.map((part: object) =>
        Object.fromEntries(
          Object.entries(part).map(([key, value]) => [
            key === "cacheControl" ? "cache_control" : key,
            value,
          ]),
        ),
      )
    : message.content;
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.callId,
      content,
    } as ChatCompletionMessageParam;
  const common = {
    role: message.role,
    ...(content === undefined ? {} : { content }),
    ...(message.name === undefined ? {} : { name: message.name }),
  };
  if (message.role !== "assistant") return common as ChatCompletionMessageParam;
  for (const call of message.toolCalls ?? []) {
    if ("type" in call || "custom" in call || "function" in call)
      throw new Error("Unsupported legacy tool call for Chat provider.");
  }
  return {
    ...common,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        }),
    ...(message.reasoningText === undefined
      ? {}
      : { reasoning_content: message.reasoningText }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.audio === undefined ? {} : { audio: message.audio }),
  } as ChatCompletionMessageParam;
}

function buildStreamEvent(
  chunk: ChatCompletionChunk,
  report: NonNullable<CreateInterfaceProviderOptions["tokenUsageReporter"]>,
): InterfaceProviderStreamEvent | null {
  if (chunk.choices.length === 0) {
    const tokenUsage = normalizeOpenAICompatibleUsage(chunk.usage, report);
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
  const textDelta = nonEmptyString(choice.delta.content);
  const reasoningDelta = reasoningDeltaFromChoiceDelta(choice.delta);
  const finishReason = mapFinishReason(choice.finish_reason);
  const tokenUsage = normalizeOpenAICompatibleUsage(chunk.usage, report);
  const event: InterfaceProviderStreamEvent = {
    ...(textDelta === undefined ? {} : { textDelta }),
    ...(reasoningDelta === undefined ? {} : { reasoningDelta }),
    ...(toolCallDeltas === undefined ? {} : { toolCallDeltas }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(choice.finish_reason === null
      ? {}
      : { rawFinishReason: choice.finish_reason }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };

  if (
    !event.textDelta &&
    !event.reasoningDelta &&
    (!event.toolCallDeltas || event.toolCallDeltas.length === 0) &&
    !event.finishReason &&
    !event.rawFinishReason &&
    !event.tokenUsage
  ) {
    return null;
  }

  return event;
}

function isUsageOnlyEvent(event: InterfaceProviderStreamEvent): boolean {
  return (
    event.tokenUsage !== undefined &&
    event.textDelta === undefined &&
    event.reasoningDelta === undefined &&
    event.finishReason === undefined &&
    event.rawFinishReason === undefined &&
    (event.toolCallDeltas === undefined || event.toolCallDeltas.length === 0)
  );
}

export function createOpenAICompatibleProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance<OpenAI> {
  const reportTokenUsage =
    options.tokenUsageReporter ?? ((_diagnostic): void => undefined);
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });

  return {
    id: options.id,
    kind: "openai-compatible",
    client,
    async streamChatCompletion(
      request: InterfaceProviderRequest,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      const stream = await client.chat.completions.create(
        buildRequestParams(request),
        {
          signal: request.signal,
        },
      );

      return (async function* (): AsyncGenerator<
        InterfaceProviderStreamEvent,
        void,
        unknown
      > {
        let pendingTerminalEvent: InterfaceProviderStreamEvent | null = null;

        for await (const chunk of stream) {
          const event = buildStreamEvent(chunk, reportTokenUsage);
          if (event) {
            if (pendingTerminalEvent) {
              if (isUsageOnlyEvent(event)) {
                const terminalEvent: InterfaceProviderStreamEvent =
                  pendingTerminalEvent;
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
