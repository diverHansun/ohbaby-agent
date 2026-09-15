import { isDeepStrictEqual } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk/error";
import type {
  ContentBlockParam,
  MessageCreateParams,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import {
  nativeOutputForMessage,
  type NativeAnthropicBlock,
  type ModelOrigin,
} from "./native-state.js";
import type { ModelMessage } from "./types.js";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderFinishReason,
  InterfaceProviderInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "./types.js";
import { toAnthropicReasoningWire } from "./reasoning.js";
import { createAnthropicUsageAccumulator } from "./token-usage.js";

interface ConvertedAnthropicMessages {
  messages: MessageParam[];
  system?: string | TextBlockParam[];
}

function mapStopReason(
  stopReason: string | null | undefined,
): InterfaceProviderFinishReason | undefined {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    // Keep the shared finish-reason enum compact while preserving the
    // original provider value via InterfaceProviderStreamEvent.rawFinishReason.
    case "pause_turn":
      return "stop";
    default:
      return undefined;
  }
}

function isTextPart(part: unknown): part is { type: string; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function normalizeTextBlocks(
  content: unknown,
  context: string,
): string | TextBlockParam[] {
  if (typeof content === "string") {
    return content;
  }

  if (content === null || content === undefined) {
    return "";
  }

  if (!Array.isArray(content)) {
    throw new Error(`Unsupported ${context} content for Anthropic provider.`);
  }

  const textBlocks = content.filter(isTextPart).map((part) => ({
    type: "text" as const,
    text: part.text,
  }));

  if (textBlocks.length === 0) {
    throw new Error(`Unsupported ${context} content for Anthropic provider.`);
  }

  return textBlocks.length === 1 ? textBlocks[0].text : textBlocks;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (content === null || content === undefined) {
    return "";
  }

  if (Array.isArray(content)) {
    const textContent = content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("");
    if (textContent) {
      return textContent;
    }
  }

  return JSON.stringify(
    Array.isArray(content)
      ? content.map((part: unknown) => {
          if (typeof part !== "object" || part === null) return part;
          return Object.fromEntries(
            Object.entries(part).map(([key, value]) => [
              key === "cacheControl" ? "cache_control" : key,
              value,
            ]),
          );
        })
      : content,
  );
}

function parseToolInput(
  rawArguments: string | undefined,
  toolName: string,
): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }

  const parsed = JSON.parse(rawArguments) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool call '${toolName}' arguments must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function convertAssistantContent(
  message: Extract<ModelMessage, { role: "assistant" }>,
  origin: ModelOrigin,
): string | ContentBlockParam[] {
  const output = nativeOutputForMessage(message, origin);
  if (output?.protocol === "anthropic") return structuredClone(output.items);
  const blocks: (TextBlockParam | ToolUseBlockParam)[] = [];
  const textContent = normalizeTextBlocks(message.content, "assistant message");

  if (typeof textContent === "string") {
    if (textContent) {
      blocks.push({
        type: "text",
        text: textContent,
      });
    }
  } else {
    blocks.push(...textContent);
  }

  for (const toolCall of message.toolCalls ?? []) {
    if ("type" in toolCall || "custom" in toolCall || "function" in toolCall)
      throw new Error("Unsupported legacy tool call for Anthropic provider.");

    const name = toolCall.name;
    if (!name) {
      throw new Error("Assistant tool call is missing function name.");
    }

    blocks.push({
      type: "tool_use",
      id: toolCall.callId,
      name,
      input: parseToolInput(toolCall.argumentsJson, name),
    });
  }

  if (blocks.length === 0) {
    return "";
  }

  return blocks.length === 1 && blocks[0].type === "text"
    ? blocks[0].text
    : blocks;
}

function convertMessages(
  messages: readonly ModelMessage[],
  origin: ModelOrigin,
): ConvertedAnthropicMessages {
  const systemParts: string[] = [];
  const anthropicMessages: MessageParam[] = [];
  let pendingToolResults: ToolResultBlockParam[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) {
      return;
    }

    anthropicMessages.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const rawMessage of messages) {
    if (
      "function_call" in rawMessage ||
      "tool_calls" in rawMessage ||
      "tool_call_id" in rawMessage
    )
      throw new Error(
        "Unsupported legacy model message for Anthropic provider.",
      );
    switch (rawMessage.role) {
      case "system":
      case "developer": {
        flushToolResults();
        const systemText = normalizeTextBlocks(
          rawMessage.content,
          `${rawMessage.role} message`,
        );
        if (typeof systemText === "string") {
          if (systemText) {
            systemParts.push(systemText);
          }
        } else {
          const mergedText = systemText.map((block) => block.text).join("");
          if (mergedText) {
            systemParts.push(mergedText);
          }
        }
        break;
      }
      case "user": {
        flushToolResults();
        anthropicMessages.push({
          role: "user",
          content: normalizeTextBlocks(rawMessage.content, "user message"),
        });
        break;
      }
      case "assistant": {
        flushToolResults();
        anthropicMessages.push({
          role: "assistant",
          content: convertAssistantContent(rawMessage, origin),
        });
        break;
      }
      case "tool": {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: rawMessage.callId,
          content: normalizeToolResultContent(rawMessage.content),
        });
        break;
      }
      default:
        throw new Error("Unsupported message role for Anthropic provider.");
    }
  }

  flushToolResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: anthropicMessages,
  };
}

function convertTools(
  tools: InterfaceProviderRequest["tools"],
): Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => {
    const parameters = tool.inputSchema;
    if (parameters.type !== "object") {
      throw new Error(`Tool '${tool.name}' must define an object JSON schema.`);
    }

    return {
      name: tool.name,
      description: tool.description,
      input_schema: parameters as Tool["input_schema"],
    };
  });
}

function applyLastBlockCacheControl(
  converted: ConvertedAnthropicMessages,
): boolean {
  const { messages } = converted;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (typeof message.content === "string") {
      if (message.content.length === 0) {
        continue;
      }
      messages[messageIndex] = {
        ...message,
        content: [
          {
            type: "text",
            text: message.content,
            cache_control: { type: "ephemeral" },
          },
        ],
      };
      return true;
    }

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = message.content[blockIndex];
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      const markedBlock = {
        ...block,
        cache_control: { type: "ephemeral" as const },
      } as ContentBlockParam;
      messages[messageIndex] = {
        ...message,
        content: message.content.map((candidate, index) =>
          index === blockIndex ? markedBlock : candidate,
        ),
      };
      return true;
    }
  }
  if (typeof converted.system === "string" && converted.system.length > 0) {
    converted.system = [
      {
        type: "text",
        text: converted.system,
        cache_control: { type: "ephemeral" },
      },
    ];
    return true;
  }
  return false;
}

function applyStableSystemCacheControl(
  converted: ConvertedAnthropicMessages,
): void {
  if (typeof converted.system === "string" && converted.system.length > 0) {
    converted.system = [
      {
        cache_control: { type: "ephemeral" },
        text: converted.system,
        type: "text",
      },
    ];
  }
}

function buildRequestParams(
  request: InterfaceProviderRequest,
  options: CreateInterfaceProviderOptions,
): MessageCreateParams {
  const convertedMessages = convertMessages(request.messages, {
    provider: options.id,
    model: request.model,
    protocol: "anthropic",
    endpoint: options.baseUrl,
  });
  if (
    request.promptCache.strategy === "anthropic-explicit-last-block" &&
    !applyLastBlockCacheControl(convertedMessages)
  ) {
    throw new Error(
      "Anthropic explicit cache strategy requires an eligible content block.",
    );
  }
  if (request.promptCache.strategy === "anthropic-top-level-auto") {
    applyStableSystemCacheControl(convertedMessages);
  }
  const params: MessageCreateParams = {
    model: request.model,
    messages: convertedMessages.messages,
    max_tokens: request.maxTokens,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
  };

  const reasoningWire = toAnthropicReasoningWire(request.reasoning);
  if (reasoningWire.thinking) params.thinking = reasoningWire.thinking;
  if (reasoningWire.output_config) {
    const effort = reasoningWire.output_config.effort;
    if (
      effort !== "low" &&
      effort !== "medium" &&
      effort !== "high" &&
      effort !== "xhigh" &&
      effort !== "max"
    ) {
      throw new Error("Unsupported Anthropic output effort.");
    }
    params.output_config = { effort };
  }

  if (convertedMessages.system?.length) {
    params.system = convertedMessages.system;
  }

  if (request.promptCache.strategy === "anthropic-top-level-auto") {
    params.cache_control = { type: "ephemeral" };
  }

  const tools = convertTools(request.tools);
  if (tools) {
    params.tools = tools;
  }

  return params;
}

interface PendingNativeBlock {
  block: NativeAnthropicBlock;
  stopped: boolean;
  json: string;
}

/** Attempt-local raw assembly keeps initial input separate from JSON deltas. */
class AnthropicNativeAccumulator {
  private readonly blocks = new Map<number, PendingNativeBlock>();
  private stopped = false;
  private finishReason: InterfaceProviderFinishReason | undefined;

  update(
    event: RawMessageStreamEvent,
  ): InterfaceProviderStreamEvent | undefined {
    if (this.stopped) throw new Error("Anthropic event after message_stop.");
    if (this.finishReason !== undefined) {
      const allowed =
        event.type === "message_stop" ||
        event.type === "content_block_stop" ||
        (event.type === "message_delta" &&
          (event.delta.stop_reason ?? null) === null) ||
        (event.type === "content_block_delta" &&
          event.delta.type === "signature_delta");
      if (!allowed) throw new Error("Anthropic output after finish reason.");
    }
    if (event.type === "message_delta") {
      this.finishReason =
        mapStopReason(event.delta.stop_reason) ?? this.finishReason;
      return;
    }
    if (event.type === "message_stop") {
      this.stopped = true;
      return;
    }
    if (event.type === "content_block_start") {
      if (event.index !== this.blocks.size || this.blocks.has(event.index)) {
        throw new Error("Conflicting Anthropic content block order.");
      }
      const raw = event.content_block;
      let block: NativeAnthropicBlock;
      switch (raw.type) {
        case "text":
          block = { type: "text", text: raw.text };
          break;
        case "thinking":
          block = {
            type: "thinking",
            thinking: raw.thinking,
            signature: raw.signature,
          };
          break;
        case "redacted_thinking":
          block = { type: "redacted_thinking", data: raw.data };
          break;
        case "tool_use":
          if (
            !raw.id ||
            !raw.name ||
            !raw.input ||
            typeof raw.input !== "object" ||
            Array.isArray(raw.input)
          ) {
            throw new Error("Invalid Anthropic tool_use block.");
          }
          if (
            [...this.blocks.values()].some(
              (entry) =>
                entry.block.type === "tool_use" && entry.block.id === raw.id,
            )
          ) {
            throw new Error("Duplicate Anthropic tool call id.");
          }
          block = {
            type: "tool_use",
            id: raw.id,
            name: raw.name,
            input: structuredClone(raw.input) as Record<string, unknown>,
          };
          break;
        default:
          throw new Error("Unsupported Anthropic native content block.");
      }
      this.blocks.set(event.index, { block, stopped: false, json: "" });
      if (block.type === "text" && block.text) return { textDelta: block.text };
      return;
    }
    if (
      event.type !== "content_block_delta" &&
      event.type !== "content_block_stop"
    )
      return;
    const entry = this.blocks.get(event.index);
    if (!entry) throw new Error("Anthropic delta references an unknown block.");
    if (event.type === "content_block_stop") {
      entry.stopped = true;
      return;
    }
    const delta = event.delta;
    if (entry.stopped && delta.type !== "signature_delta")
      throw new Error("Anthropic delta after content block stop.");
    switch (delta.type) {
      case "text_delta":
        if (entry.block.type !== "text")
          throw new Error("Conflicting Anthropic text delta.");
        entry.block.text += delta.text;
        break;
      case "thinking_delta":
        if (entry.block.type !== "thinking")
          throw new Error("Conflicting Anthropic thinking delta.");
        entry.block.thinking += delta.thinking;
        break;
      case "signature_delta":
        if (entry.block.type !== "thinking")
          throw new Error("Conflicting Anthropic signature delta.");
        if (entry.block.signature && entry.block.signature !== delta.signature)
          throw new Error("Conflicting Anthropic signature.");
        entry.block.signature = delta.signature;
        break;
      case "input_json_delta":
        if (entry.block.type !== "tool_use")
          throw new Error("Conflicting Anthropic tool input delta.");
        entry.json += delta.partial_json;
        break;
      case "citations_delta":
        if (entry.block.type !== "text")
          throw new Error("Conflicting Anthropic citations delta.");
        break;
      default:
        throw new Error("Unsupported Anthropic native delta.");
    }
    return undefined;
  }

  finalize(): InterfaceProviderStreamEvent | undefined {
    if (this.blocks.size === 0) return;
    if (!this.stopped || !this.finishReason)
      throw new Error("Incomplete Anthropic message stream.");
    // Truncated output can retain trusted usage, but cannot become replayable state.
    if (
      this.finishReason === "length" ||
      this.finishReason === "content_filter"
    )
      return;
    const items: NativeAnthropicBlock[] = [];
    const toolCallDeltas: NonNullable<
      InterfaceProviderStreamEvent["toolCallDeltas"]
    > = [];
    for (const [index, entry] of this.blocks) {
      if (!entry.stopped)
        throw new Error("Incomplete Anthropic content block.");
      const block = entry.block;
      if (block.type === "thinking" && !block.signature)
        throw new Error("Anthropic thinking signature is missing.");
      if (block.type === "redacted_thinking" && !block.data)
        throw new Error("Anthropic redacted thinking data is missing.");
      if (block.type === "tool_use") {
        if (entry.json.length > 0) {
          const parsed = parseToolInput(entry.json, block.name);
          if (
            Object.keys(block.input).length > 0 &&
            !isDeepStrictEqual(block.input, parsed)
          ) {
            throw new Error(
              "Conflicting Anthropic initial tool input and JSON deltas.",
            );
          }
          block.input = parsed;
        } else {
          toolCallDeltas.push({
            index,
            argumentsDelta: JSON.stringify(block.input),
          });
        }
      }
      items.push(block);
    }
    const needsNative =
      items.length > 1 || items.some((block) => block.type !== "text");
    if (!needsNative && toolCallDeltas.length === 0) return;
    return {
      ...(needsNative
        ? { nativeOutput: { protocol: "anthropic" as const, items } }
        : {}),
      ...(toolCallDeltas.length > 0 ? { toolCallDeltas } : {}),
    };
  }
}

function buildStreamEvent(
  event: RawMessageStreamEvent,
  tokenUsage: InterfaceProviderStreamEvent["tokenUsage"],
): InterfaceProviderStreamEvent | null {
  switch (event.type) {
    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        return {
          toolCallDeltas: [
            {
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            },
          ],
        };
      }
      return null;
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        return { textDelta: event.delta.text };
      }
      if (event.delta.type === "input_json_delta") {
        return {
          toolCallDeltas: [
            {
              index: event.index,
              argumentsDelta: event.delta.partial_json,
            },
          ],
        };
      }
      return null;
    case "message_delta": {
      const streamEvent: InterfaceProviderStreamEvent = {
        finishReason: mapStopReason(event.delta.stop_reason),
        rawFinishReason: event.delta.stop_reason ?? undefined,
        tokenUsage,
      };

      return streamEvent.finishReason || streamEvent.tokenUsage
        ? streamEvent
        : null;
    }
    case "message_start":
      return tokenUsage ? { tokenUsage } : null;
    case "content_block_stop":
    case "message_stop":
    default:
      return null;
  }
}

export function createAnthropicProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance<Anthropic> {
  const reportTokenUsage =
    options.tokenUsageReporter ?? ((_diagnostic): void => undefined);
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });

  return {
    id: options.id,
    kind: "anthropic",
    client,
    streamResponse(
      request: InterfaceProviderRequest,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      const stream = client.messages.stream(
        buildRequestParams(request, options),
        {
          signal: request.signal,
        },
      );

      return Promise.resolve(
        (async function* (): AsyncGenerator<
          InterfaceProviderStreamEvent,
          void,
          unknown
        > {
          const usage = createAnthropicUsageAccumulator(reportTokenUsage);
          const native = new AnthropicNativeAccumulator();
          let reasoningTokens: number | undefined;
          for await (const rawEvent of stream) {
            const initial = native.update(rawEvent);
            if (initial) yield initial;
            const rawUsage =
              rawEvent.type === "message_start"
                ? rawEvent.message.usage
                : rawEvent.type === "message_delta"
                  ? rawEvent.usage
                  : undefined;
            const tokenUsage = rawUsage ? usage.update(rawUsage) : undefined;
            const thinkingTokens =
              rawUsage?.output_tokens_details?.thinking_tokens;
            if (
              thinkingTokens !== undefined &&
              Number.isInteger(thinkingTokens) &&
              thinkingTokens >= 0
            ) {
              reasoningTokens = thinkingTokens;
            }
            if (rawEvent.type === "message_start") {
              // message_start usage initializes attempt-local accounting. It
              // is deliberately not exposed as a half-complete provider frame;
              // the terminal message_delta receives the merged snapshot.
              continue;
            }
            const event = buildStreamEvent(rawEvent, tokenUsage);
            if (event) {
              yield {
                ...event,
                ...(rawEvent.type === "message_delta" &&
                reasoningTokens !== undefined
                  ? { reasoningTokens }
                  : {}),
              };
            }
          }
          const final = native.finalize();
          if (final) yield final;
        })(),
      );
    },
    isAbortError(error: unknown): boolean {
      return error instanceof APIUserAbortError;
    },
  };
}
