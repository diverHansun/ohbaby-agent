import Anthropic from "@anthropic-ai/sdk";
import { APIUserAbortError } from "@anthropic-ai/sdk/error";
import type {
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
  InterfaceProviderTokenUsage,
} from "./types.js";

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

function normalizeTokenUsage(
  usage:
    | {
        input_tokens: number | null;
        output_tokens: number;
      }
    | null
    | undefined,
): InterfaceProviderTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
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

function convertMessages(messages: ChatCompletionMessageParam[]): {
  system?: string;
  messages: MessageParam[];
} {
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

function buildRequestParams(
  request: InterfaceProviderRequest,
): MessageCreateParams {
  const convertedMessages = convertMessages(request.messages);
  const params: MessageCreateParams = {
    model: request.model,
    messages: convertedMessages.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
  };

  if (convertedMessages.system?.length) {
    params.system = convertedMessages.system;
  }

  const tools = convertTools(request.tools);
  if (tools) {
    params.tools = tools;
  }

  return params;
}

function buildStreamEvent(
  event: RawMessageStreamEvent,
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
        tokenUsage: normalizeTokenUsage(event.usage),
      };

      return streamEvent.finishReason || streamEvent.tokenUsage
        ? streamEvent
        : null;
    }
    case "message_start":
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
          for await (const rawEvent of stream) {
            const event = buildStreamEvent(rawEvent);
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
