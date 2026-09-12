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
          ["role", "content", "tool_calls"],
          "assistant message",
        );
        if (typeof message.content === "string")
          input.push({ role: "assistant", content: message.content });
        else if (message.content !== undefined && message.content !== null)
          rejectRequest(
            "assistant content must be a string or absent with tool calls",
          );
        if (message.tool_calls !== undefined) {
          if (!Array.isArray(message.tool_calls))
            rejectRequest("tool_calls must be an array");
          for (const rawCall of message.tool_calls) {
            const call = object(rawCall, "tool_call");
            allowedKeys(call, ["id", "type", "function"], "tool_call");
            if (call.type !== "function")
              rejectRequest("tool_call type must be function");
            const fn = object(call.function, "tool_call function");
            allowedKeys(fn, ["name", "arguments"], "tool_call function");
            input.push({
              type: "function_call",
              call_id: string(call.id, "call id", true),
              name: string(fn.name, "function name", true),
              arguments: string(fn.arguments, "function arguments"),
            });
          }
        }
        if (
          (message.content === undefined || message.content === null) &&
          (!Array.isArray(message.tool_calls) ||
            message.tool_calls.length === 0)
        )
          rejectRequest("assistant requires text or tool calls");
        break;
      }
      case "tool":
        allowedKeys(
          message,
          ["role", "content", "tool_call_id"],
          "tool message",
        );
        input.push({
          type: "function_call_output",
          call_id: string(message.tool_call_id, "tool_call_id", true),
          output: string(message.content, "tool content"),
        });
        break;
      default:
        rejectRequest(`unsupported message role ${String(message.role)}`);
    }
  }
  const tools = request.tools?.map((rawTool): FunctionTool => {
    const tool = object(rawTool, "tool");
    allowedKeys(tool, ["type", "function"], "tool");
    if (tool.type !== "function") rejectRequest("tool type must be function");
    const fn = object(tool.function, "tool function");
    allowedKeys(fn, ["name", "description", "parameters"], "tool function");
    return {
      type: "function",
      name: string(fn.name, "tool name", true),
      parameters: object(fn.parameters, "parameters"),
      strict: false,
      ...(fn.description === undefined
        ? {}
        : { description: string(fn.description, "description") }),
    };
  });
  return {
    model: request.model,
    input,
    temperature: request.temperature,
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
    async streamChatCompletion(
      request,
    ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
      if (request.signal?.aborted) throw new APIUserAbortError();
      const stream = await client.responses.create(
        buildRequestParams(request),
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
