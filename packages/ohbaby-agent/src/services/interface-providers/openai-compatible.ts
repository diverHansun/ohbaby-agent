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
import {
  nativeOutputForMessage,
  NativeOutputSchema,
  ChatReasoningIndexSchema,
  type NativeOutput,
  type ModelOrigin,
} from "./native-state.js";
import { toChatReasoningWire } from "./reasoning.js";
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

function reasoningTextDeltaFromChoiceDelta(
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
  options: CreateInterfaceProviderOptions,
): ChatCompletionCreateParamsStreaming {
  type PromptCacheWireParams = ChatCompletionCreateParamsStreaming & {
    prompt_cache_key?: string;
  };
  const params: PromptCacheWireParams = {
    model: request.model,
    messages: request.messages.map((message) =>
      projectMessage(message, {
        provider: options.id,
        model: request.model,
        protocol: "openai-compatible",
        endpoint: options.baseUrl,
      }),
    ),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  Object.assign(params, toChatReasoningWire(request.reasoning));

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

function projectMessage(
  message: ModelMessage,
  origin: ModelOrigin,
): ChatCompletionMessageParam {
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
  const native = nativeOutputForMessage(message, origin);
  const nativeReasoning =
    native?.protocol === "openai-compatible"
      ? {
          ...(native.reasoningText === undefined
            ? {}
            : {
                [native.reasoningField ?? "reasoning_content"]:
                  native.reasoningText,
              }),
          ...(native.reasoningDetails === undefined
            ? {}
            : { reasoning_details: structuredClone(native.reasoningDetails) }),
        }
      : undefined;
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
    ...(nativeReasoning ??
      (message.modelState !== undefined || message.reasoningText === undefined
        ? {}
        : { reasoning_content: message.reasoningText })),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.audio === undefined ? {} : { audio: message.audio }),
  } as ChatCompletionMessageParam;
}

function buildStreamEvent(
  chunk: ChatCompletionChunk,
  report: NonNullable<CreateInterfaceProviderOptions["tokenUsageReporter"]>,
): InterfaceProviderStreamEvent | null {
  const rawReasoningTokens =
    chunk.usage?.completion_tokens_details?.reasoning_tokens;
  const reasoningTokens =
    rawReasoningTokens !== undefined &&
    Number.isInteger(rawReasoningTokens) &&
    rawReasoningTokens >= 0
      ? rawReasoningTokens
      : undefined;
  if (chunk.choices.length === 0) {
    const tokenUsage = normalizeOpenAICompatibleUsage(chunk.usage, report);
    return tokenUsage || reasoningTokens !== undefined
      ? {
          ...(tokenUsage ? { tokenUsage } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        }
      : null;
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
  const reasoningTextDelta = reasoningTextDeltaFromChoiceDelta(choice.delta);
  const finishReason = mapFinishReason(choice.finish_reason);
  const tokenUsage = normalizeOpenAICompatibleUsage(chunk.usage, report);
  const event: InterfaceProviderStreamEvent = {
    ...(textDelta === undefined ? {} : { textDelta }),
    ...(reasoningTextDelta === undefined ? {} : { reasoningTextDelta }),
    ...(toolCallDeltas === undefined ? {} : { toolCallDeltas }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(choice.finish_reason === null
      ? {}
      : { rawFinishReason: choice.finish_reason }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };

  if (
    !event.textDelta &&
    !event.reasoningTextDelta &&
    (!event.toolCallDeltas || event.toolCallDeltas.length === 0) &&
    !event.finishReason &&
    !event.rawFinishReason &&
    !event.tokenUsage &&
    event.reasoningTokens === undefined
  ) {
    return null;
  }

  return event;
}

function isUsageOnlyEvent(event: InterfaceProviderStreamEvent): boolean {
  return (
    (event.tokenUsage !== undefined || event.reasoningTokens !== undefined) &&
    event.textDelta === undefined &&
    event.reasoningTextDelta === undefined &&
    event.finishReason === undefined &&
    event.rawFinishReason === undefined &&
    (event.toolCallDeltas === undefined || event.toolCallDeltas.length === 0)
  );
}

class ChatNativeAccumulator {
  private text = "";
  private field: "reasoning_content" | "reasoning" | undefined;
  private readonly details = new Map<string, Record<string, unknown>>();
  private finish: InterfaceProviderFinishReason | undefined;

  update(chunk: ChatCompletionChunk): void {
    if (chunk.choices.length === 0) return;
    const choice = chunk.choices[0];
    if (
      this.finish !== undefined &&
      ((choice.finish_reason ?? null) !== null ||
        Object.values(choice.delta).some(
          (value) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            !(Array.isArray(value) && value.length === 0),
        ))
    )
      throw new Error("Chat output after finish reason.");
    this.finish = mapFinishReason(choice.finish_reason) ?? this.finish;
    const delta = choice.delta as Record<string, unknown>;
    const content = nonEmptyString(delta.reasoning_content);
    const reasoning = nonEmptyString(delta.reasoning);
    if (
      content !== undefined &&
      reasoning !== undefined &&
      content !== reasoning
    )
      throw new Error("Conflicting Chat reasoning text fields.");
    const text = content ?? reasoning;
    if (text !== undefined) {
      const field = content !== undefined ? "reasoning_content" : "reasoning";
      if (this.field !== undefined && this.field !== field)
        throw new Error("Conflicting Chat reasoning field during stream.");
      this.field = field;
      this.text += text;
    }
    if (
      delta.reasoning_details === undefined ||
      delta.reasoning_details === null
    )
      return;
    if (!Array.isArray(delta.reasoning_details))
      throw new Error("Invalid Chat reasoning details.");
    for (const raw of delta.reasoning_details as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Invalid Chat reasoning detail.");
      const detail = raw as Record<string, unknown>;
      const allowed = [
        "type",
        "id",
        "format",
        "index",
        "text",
        "summary",
        "signature",
        "data",
      ];
      if (Object.keys(detail).some((key) => !allowed.includes(key)))
        throw new Error("Unsupported Chat reasoning detail field.");
      const parsedIndex = ChatReasoningIndexSchema.optional().safeParse(
        detail.index,
      );
      if (!parsedIndex.success)
        throw new Error("Invalid Chat reasoning detail index.");
      if (detail.type !== undefined && typeof detail.type !== "string")
        throw new Error("Invalid Chat reasoning detail type.");
      // A Responses reasoning item can have both a summary and encrypted
      // detail at the same index. They are separate ordered replay entries.
      let key: string;
      if (parsedIndex.data !== undefined) {
        const prefix = `index:${String(parsedIndex.data)}:`;
        if (detail.type === undefined) {
          const candidates = [...this.details.keys()].filter((candidate) =>
            candidate.startsWith(prefix),
          );
          if (candidates.length !== 1)
            throw new Error("Ambiguous Chat reasoning detail delta.");
          key = candidates[0];
        } else key = `${prefix}${detail.type}`;
      } else {
        const matchingId =
          typeof detail.id === "string"
            ? [...this.details.entries()].filter(
                ([, item]) =>
                  item.id === detail.id &&
                  (detail.type === undefined || item.type === detail.type),
              )
            : [];
        if (matchingId.length > 1)
          throw new Error("Ambiguous Chat reasoning detail identity.");
        key =
          matchingId[0]?.[0] ??
          (typeof detail.id === "string"
            ? `id:${detail.id}:${String(detail.type)}`
            : `anonymous:${String(this.details.size)}`);
      }
      const existing = this.details.get(key);
      if (!existing) {
        if (
          ![
            "reasoning.text",
            "reasoning.summary",
            "reasoning.encrypted",
          ].includes(String(detail.type))
        )
          throw new Error("Unsupported Chat reasoning detail type.");
        if (
          typeof detail.id === "string" &&
          [...this.details.values()].some(
            (item) => item.id === detail.id && item.type === detail.type,
          )
        )
          throw new Error("Conflicting Chat reasoning detail index.");
        this.details.set(key, { ...detail });
        continue;
      }
      if (
        typeof detail.id === "string" &&
        [...this.details.entries()].some(
          ([otherKey, item]) =>
            otherKey !== key &&
            item.id === detail.id &&
            item.type === existing.type,
        )
      )
        throw new Error("Conflicting Chat reasoning detail identity.");
      for (const [field, value] of Object.entries(detail)) {
        if (value === undefined) continue;
        if (["text", "summary", "data"].includes(field)) {
          if (typeof value !== "string")
            throw new Error("Invalid Chat reasoning detail payload.");
          if (
            existing[field] !== undefined &&
            typeof existing[field] !== "string"
          )
            throw new Error("Conflicting Chat reasoning detail payload.");
          existing[field] = (existing[field] ?? "") + value;
        } else {
          if (
            existing[field] !== undefined &&
            existing[field] !== null &&
            value !== null &&
            existing[field] !== value
          )
            throw new Error(
              "Conflicting Chat reasoning detail identity or signature.",
            );
          if (value !== null || existing[field] === undefined)
            existing[field] = value;
        }
      }
    }
  }

  finalize(): NativeOutput | undefined {
    if (this.field === undefined && this.details.size === 0) return;
    if (this.finish === undefined)
      throw new Error("Incomplete Chat native reasoning stream.");
    if (this.finish === "length" || this.finish === "content_filter") return;
    for (const detail of this.details.values()) {
      const payloadFields =
        detail.type === "reasoning.text"
          ? ["text", "signature"]
          : detail.type === "reasoning.summary"
            ? ["summary"]
            : ["data"];
      const allowed = ["type", "id", "format", "index", ...payloadFields];
      if (Object.keys(detail).some((key) => !allowed.includes(key)))
        throw new Error("Unsupported fields for Chat reasoning detail type.");
    }
    return NativeOutputSchema.parse({
      protocol: "openai-compatible",
      ...(this.field === undefined
        ? {}
        : { reasoningText: this.text, reasoningField: this.field }),
      ...(this.details.size === 0
        ? {}
        : { reasoningDetails: [...this.details.values()] }),
    });
  }
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
    async streamResponse(
      request: InterfaceProviderRequest,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      const stream = await client.chat.completions.create(
        buildRequestParams(request, options),
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
        const native = new ChatNativeAccumulator();

        for await (const chunk of stream) {
          native.update(chunk);
          const event = buildStreamEvent(chunk, reportTokenUsage);
          if (event) {
            if (pendingTerminalEvent) {
              if (isUsageOnlyEvent(event)) {
                const terminalEvent: InterfaceProviderStreamEvent =
                  pendingTerminalEvent;
                pendingTerminalEvent = {
                  ...terminalEvent,
                  ...(event.tokenUsage === undefined
                    ? {}
                    : { tokenUsage: event.tokenUsage }),
                  ...(event.reasoningTokens === undefined
                    ? {}
                    : { reasoningTokens: event.reasoningTokens }),
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

        const nativeOutput = native.finalize();
        if (pendingTerminalEvent) {
          yield {
            ...pendingTerminalEvent,
            ...(nativeOutput === undefined ? {} : { nativeOutput }),
          };
        } else if (nativeOutput) {
          yield { nativeOutput };
        }
      })();
    },
    isAbortError(error: unknown): boolean {
      return error instanceof APIUserAbortError;
    },
  };
}
