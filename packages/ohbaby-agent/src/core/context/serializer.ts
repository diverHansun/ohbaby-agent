import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageWithParts, Part, ToolPart } from "../message/index.js";
import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
  type PromptSecurityFinding,
} from "../system-prompt/security/index.js";
import { isActivePart } from "./filters.js";
import { isSummaryMessage } from "./summary.js";
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
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly isSubagent: boolean;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
}): ChatCompletionMessage[] {
  const systemPrompt = input.isSubagent
    ? input.systemPrompt
    : appendMemoryToSystemPrompt(
        input.systemPrompt,
        loadMemoryForPrompt(input.memory.merged, input.onSecurityFinding),
      );
  const messages = serializeHistoryMessages(
    input.history,
    input.activeReasoningByMessageId,
  );

  if (systemPrompt.trim() === "") {
    return messages;
  }

  return [{ role: "system", content: systemPrompt }, ...messages];
}

export function serializeHistoryMessages(
  history: readonly MessageWithParts[],
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
): ChatCompletionMessage[] {
  return history.flatMap((message) =>
    serializeMessageForLlm(message, activeReasoningByMessageId),
  );
}

function serializeMessageForLlm(
  message: MessageWithParts,
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
): ChatCompletionMessage[] {
  if (message.info.role === "assistant" && message.info.finish === "error") {
    return [];
  }

  const parts = message.parts.filter(isActivePart);
  if (parts.length === 0) {
    return [];
  }

  if (isSummaryMessage({ info: message.info, parts })) {
    const summary = textContentFromParts(parts).trim();
    if (summary === "") {
      return [];
    }
    return [
      {
        role: "user",
        content: `<context_summary>\n${summary}\n</context_summary>`,
      },
    ];
  }

  if (message.info.role === "assistant") {
    return serializeAssistantMessage(
      message,
      parts,
      activeReasoningByMessageId,
    );
  }

  const content = textContentFromParts(parts);
  if (content === "") {
    return [];
  }

  return [{ role: message.info.role, content }];
}

function serializeAssistantMessage(
  message: MessageWithParts,
  parts: readonly Part[],
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
): ChatCompletionMessage[] {
  const completedToolParts = parts.filter(isCompletedToolPart);
  const content = textContentFromParts(parts);

  if (completedToolParts.length === 0) {
    return content === "" ? [] : [{ role: "assistant", content }];
  }

  const assistantMessage = {
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
  } satisfies ChatCompletionMessage;
  const reasoning = activeReasoningByMessageId?.get(message.info.id);
  const assistantWithReasoning =
    reasoning === undefined || reasoning === ""
      ? assistantMessage
      : ({
          ...assistantMessage,
          reasoning_content: reasoning,
        } as ChatCompletionMessage);

  return [
    assistantWithReasoning,
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
