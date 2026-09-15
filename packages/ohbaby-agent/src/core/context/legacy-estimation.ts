import type {
  ModelMessage,
  ModelToolDefinition,
} from "../../services/interface-providers/types.js";

/** Short-lived measurement material; never a provider request or retained state. */
export function legacyMessageForEstimation(message: ModelMessage): object {
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
    return { role: message.role, tool_call_id: message.callId, content };
  return {
    role: message.role,
    ...(content === undefined ? {} : { content }),
    ...(message.role === "assistant" && message.toolCalls !== undefined
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        }
      : {}),
    ...(message.role === "assistant" &&
    message.modelState === undefined &&
    message.reasoningText !== undefined
      ? legacyReasoningForEstimation(message.reasoningText)
      : {}),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.role === "assistant" && message.refusal !== undefined
      ? { refusal: message.refusal }
      : {}),
    ...(message.role === "assistant" && message.audio !== undefined
      ? { audio: message.audio }
      : {}),
  };
}

export function legacyToolForEstimation(tool: ModelToolDefinition): object {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  };
}

export function legacyReasoningForEstimation(reasoningText: string): object {
  return { reasoning_content: reasoningText };
}
