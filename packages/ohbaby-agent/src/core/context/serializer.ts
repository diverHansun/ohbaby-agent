import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageWithParts, Part, ToolPart } from "../message/index.js";
import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
  type PromptSecurityFinding,
} from "../system-prompt/security/index.js";
import { isActivePart } from "./filters.js";
import { formatToolResultContentForModel } from "./tool-metadata-projection.js";

export function appendMemoryToSystemPrompt(
  systemPrompt: string,
  memory: string,
): string {
  const trimmedMemory = memory.trim();
  if (trimmedMemory === "") {
    return systemPrompt;
  }

  return [systemPrompt.trim(), `<memory>\n${trimmedMemory}\n</memory>`]
    .filter(Boolean)
    .join("\n\n");
}

export function loadMemoryForPrompt(
  memory: string,
  onSecurityFinding?: (finding: PromptSecurityFinding) => void,
): string {
  const trimmedMemory = memory.trim();
  if (trimmedMemory === "") {
    return "";
  }

  const scan = scanPromptLikeContent(trimmedMemory, {
    kind: "memory",
    label: "Memory",
  });
  for (const finding of scan.findings) {
    onSecurityFinding?.(finding);
  }

  return shouldLoadPromptLikeContent(scan) ? trimmedMemory : "";
}

export function serializeForLlm(input: {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly isSubagent: boolean;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
}): ChatCompletionMessage[] {
  const systemPrompt = input.isSubagent
    ? input.systemPrompt
    : appendMemoryToSystemPrompt(
        input.systemPrompt,
        loadMemoryForPrompt(input.memory.merged, input.onSecurityFinding),
      );
  const messages = serializeHistoryMessages(input.history);

  if (systemPrompt.trim() === "") {
    return messages;
  }

  return [{ role: "system", content: systemPrompt }, ...messages];
}

export function serializeHistoryMessages(
  history: readonly MessageWithParts[],
): ChatCompletionMessage[] {
  return history.flatMap(serializeMessageForLlm);
}

function serializeMessageForLlm(
  message: MessageWithParts,
): ChatCompletionMessage[] {
  if (message.info.role === "assistant" && message.info.finish === "error") {
    return [];
  }

  const parts = message.parts.filter(isActivePart);
  if (parts.length === 0) {
    return [];
  }

  if (message.info.role === "assistant") {
    return serializeAssistantMessage(message, parts);
  }

  const content = textContentFromParts(parts);
  if (content === "") {
    return [];
  }

  return [{ role: message.info.role, content }];
}

function serializeAssistantMessage(
  _message: MessageWithParts,
  parts: readonly Part[],
): ChatCompletionMessage[] {
  const completedToolParts = parts.filter(isCompletedToolPart);
  const content = textContentFromParts(parts);

  if (completedToolParts.length === 0) {
    return content === "" ? [] : [{ role: "assistant", content }];
  }

  return [
    {
      role: "assistant",
      content: content === "" ? null : content,
      tool_calls: completedToolParts.map((part) => ({
        id: part.callId,
        type: "function",
        function: {
          name: part.tool,
          arguments: JSON.stringify(part.state.input),
        },
      })),
    },
    ...completedToolParts.map((part) => ({
      role: "tool" as const,
      tool_call_id: part.callId,
      content: toolResultContent(part),
    })),
  ];
}

function textContentFromParts(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.ignored ? "" : part.text;
      }
      if (part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function isCompletedToolPart(part: Part): part is ToolPart {
  return (
    part.type === "tool" &&
    (part.state.status === "completed" ||
      part.state.status === "error" ||
      part.state.status === "aborted")
  );
}

function toolResultContent(part: ToolPart): string {
  switch (part.state.status) {
    case "completed":
      return formatToolResultContentForModel({
        content: part.state.output,
        metadata: part.state.metadata,
        tool: part.tool,
      });
    case "error":
      return formatToolResultContentForModel({
        content: part.state.error,
        metadata: part.state.metadata,
        tool: part.tool,
      });
    case "aborted":
      return formatToolResultContentForModel({
        content:
          part.state.output === undefined || part.state.output === ""
            ? part.state.error
            : `${part.state.output}\n\n${part.state.error}`,
        metadata: part.state.metadata,
        tool: part.tool,
      });
    case "pending":
      return part.state.raw;
    case "running":
      return part.state.title ?? "";
  }
}
