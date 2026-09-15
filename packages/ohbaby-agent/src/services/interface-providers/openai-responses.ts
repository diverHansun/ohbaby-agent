import OpenAI, { APIUserAbortError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  FunctionTool,
} from "openai/resources/responses/responses";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "./types.js";
import { nativeOutputForMessage, type ModelOrigin } from "./native-state.js";
import { toResponsesReasoningWire } from "./reasoning.js";
import { mapResponsesStream } from "./openai-responses-stream.js";

function rejectRequest(reason: string): never {
  throw new Error(`Responses request: ${reason}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return rejectRequest(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key))
      rejectRequest(`${label} has unsupported field ${String(key)}`);
  }
}

function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0))
    return rejectRequest(
      `${label} must be ${nonempty ? "a nonempty" : "a"} string`,
    );
  return value;
}

function buildRequestParams(
  request: InterfaceProviderRequest,
  origin: ModelOrigin,
): ResponseCreateParamsStreaming {
  const instructions: string[] = [];
  const input: ResponseInput = [];
  for (const rawMessage of request.messages) {
    const message = object(rawMessage, "message");
    switch (message.role) {
      case "system":
        allowedKeys(message, ["role", "content"], "system message");
        instructions.push(string(message.content, "system content"));
        break;
      case "user":
        allowedKeys(message, ["role", "content"], "user message");
        input.push({
          role: "user",
          content: string(message.content, "user content"),
        });
        break;
      case "assistant": {
        allowedKeys(
          message,
          ["role", "content", "toolCalls", "modelState"],
          "assistant message",
        );
        if (rawMessage.role !== "assistant")
          rejectRequest("invalid assistant role");
        const native = nativeOutputForMessage(rawMessage, origin);
        if (native !== undefined) {
          if (native.protocol !== "openai-responses")
            rejectRequest("native output protocol mismatch");
          input.push(...native.items);
          break;
        }
        if (typeof message.content === "string")
          input.push({ role: "assistant", content: message.content });
        else if (message.content !== undefined && message.content !== null)
          rejectRequest(
            "assistant content must be a string or absent with tool calls",
          );
        if (message.toolCalls !== undefined) {
          if (!Array.isArray(message.toolCalls))
            rejectRequest("toolCalls must be an array");
          for (const rawCall of message.toolCalls) {
            const call = object(rawCall, "tool_call");
            allowedKeys(call, ["callId", "name", "argumentsJson"], "tool_call");
            input.push({
              type: "function_call",
              call_id: string(call.callId, "call id", true),
              name: string(call.name, "function name", true),
              arguments: string(call.argumentsJson, "function arguments"),
            });
          }
        }
        if (
          (message.content === undefined || message.content === null) &&
          (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0)
        )
          rejectRequest("assistant requires text or tool calls");
        break;
      }
      case "tool":
        allowedKeys(message, ["role", "content", "callId"], "tool message");
        input.push({
          type: "function_call_output",
          call_id: string(message.callId, "callId", true),
          output: string(message.content, "tool content"),
        });
        break;
      default:
        rejectRequest(`unsupported message role ${String(message.role)}`);
    }
  }
  const tools = request.tools?.map((rawTool): FunctionTool => {
    const tool = object(rawTool, "tool");
    allowedKeys(tool, ["name", "description", "inputSchema"], "tool");
    return {
      type: "function",
      name: string(tool.name, "tool name", true),
      parameters: object(tool.inputSchema, "parameters"),
      strict: false,
      ...(tool.description === undefined
        ? {}
        : { description: string(tool.description, "description") }),
    };
  });
  const reasoningWire = toResponsesReasoningWire(request.reasoning);
  const effort = reasoningWire.reasoning?.effort;
  if (
    effort !== undefined &&
    effort !== "none" &&
    effort !== "minimal" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh"
  )
    rejectRequest(`unsupported Responses reasoning effort ${effort}`);
  return {
    model: request.model,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(reasoningWire.include === undefined
      ? {}
      : { include: reasoningWire.include }),
    input,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    max_output_tokens: request.maxTokens,
    store: false,
    stream: true,
    ...(instructions.length === 0
      ? {}
      : { instructions: instructions.join("\n\n") }),
    ...(!tools?.length ? {} : { tools }),
  };
}

export function createOpenAIResponsesProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance<OpenAI> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
  });
  return {
    id: options.id,
    kind: "openai-responses",
    client,
    async streamResponse(
      request,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      if (request.signal?.aborted) throw new APIUserAbortError();
      const stream = await client.responses.create(
        buildRequestParams(request, {
          provider: options.id,
          model: request.model,
          protocol: "openai-responses",
          endpoint: options.baseUrl,
        }),
        { signal: request.signal },
      );
      return mapResponsesStream(
        stream,
        options.tokenUsageReporter,
        request.signal,
      );
    },
    isAbortError(error): boolean {
      return error instanceof APIUserAbortError;
    },
  };
}
