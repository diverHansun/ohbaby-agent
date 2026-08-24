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
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderFinishReason,
  InterfaceProviderInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "./types.js";
import { createAnthropicUsageAccumulator } from "./token-usage.js";

type OpenAIMessageWithExtras = ChatCompletionMessageParam & {
  role: string;
  content?: unknown;
  tool_calls?: {
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }[];
  tool_call_id?: string;
};

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

  return JSON.stringify(content);
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
  message: OpenAIMessageWithExtras,
): string | (TextBlockParam | ToolUseBlockParam)[] {
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

  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.type && toolCall.type !== "function") {
      throw new Error("Anthropic provider only supports function tool calls.");
    }

    const name = toolCall.function?.name;
    if (!name) {
      throw new Error("Assistant tool call is missing function name.");
    }

    blocks.push({
      type: "tool_use",
      id: toolCall.id ?? "",
      name,
      input: parseToolInput(toolCall.function?.arguments, name),
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
  messages: ChatCompletionMessageParam[],
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

  for (const rawMessage of messages as OpenAIMessageWithExtras[]) {
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
          content: convertAssistantContent(rawMessage),
        });
        break;
      }
      case "tool": {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: rawMessage.tool_call_id,
          content: normalizeToolResultContent(rawMessage.content),
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported message role '${rawMessage.role}' for Anthropic provider.`,
        );
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
    const parameters = tool.function.parameters;
    if (parameters?.type !== "object") {
      throw new Error(
        `Tool '${tool.function.name}' must define an object JSON schema.`,
      );
    }

    return {
      name: tool.function.name,
      description: tool.function.description,
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
): MessageCreateParams {
  const convertedMessages = convertMessages(request.messages);
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
    temperature: request.temperature,
  };

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
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });

  return {
    id: options.id,
    kind: "anthropic",
    client,
    streamChatCompletion(
      request: InterfaceProviderRequest,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      const stream = client.messages.stream(buildRequestParams(request), {
        signal: request.signal,
      });

      return Promise.resolve(
        (async function* (): AsyncGenerator<
          InterfaceProviderStreamEvent,
          void,
          unknown
        > {
          const usage = createAnthropicUsageAccumulator();
          for await (const rawEvent of stream) {
            const tokenUsage =
              rawEvent.type === "message_start"
                ? usage.update(rawEvent.message.usage)
                : rawEvent.type === "message_delta"
                  ? usage.update(rawEvent.usage)
                  : undefined;
            if (rawEvent.type === "message_start") {
              // message_start usage initializes attempt-local accounting. It
              // is deliberately not exposed as a half-complete provider frame;
              // the terminal message_delta receives the merged snapshot.
              continue;
            }
            const event = buildStreamEvent(rawEvent, tokenUsage);
            if (event) {
              yield event;
            }
          }
        })(),
      );
    },
    isAbortError(error: unknown): boolean {
      return error instanceof APIUserAbortError;
    },
  };
}
