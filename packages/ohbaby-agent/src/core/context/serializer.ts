import {
  ModelStateSchema,
  validateNativeProjection,
  sameModelOrigin,
  type ModelOrigin,
} from "../../services/interface-providers/native-state.js";
import type { ModelMessage } from "../llm-client/index.js";
import type { MergedMemory } from "../memory/index.js";
import type { MessageWithParts, Part, ToolPart } from "../message/index.js";
import { isInterruptionFactPart } from "../message/interruption.js";
import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
  type PromptSecurityFinding,
} from "../system-prompt/security/index.js";
import { isActivePart } from "./filters.js";
import {
  selectActiveInterruptionText,
  selectFailedHistoryText,
} from "./failed-history.js";
import { isSummaryMessage } from "./summary.js";
import { formatToolResultContentForModel } from "./tool-metadata-projection.js";

const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted before a durable result was recorded. Side effects may have occurred; verify before retrying.";

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
  readonly modelOrigin?: ModelOrigin;
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly activeReasoningByMessageId?: ReadonlyMap<string, string>;
  readonly isSubagent: boolean;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
}): ModelMessage[] {
  const systemPrompt = input.isSubagent
    ? input.systemPrompt
    : appendMemoryToSystemPrompt(
        input.systemPrompt,
        loadMemoryForPrompt(input.memory.merged, input.onSecurityFinding),
      );
  const messages = serializeHistoryMessages(
    input.history,
    input.activeReasoningByMessageId,
    input.modelOrigin,
  );

  if (systemPrompt.trim() === "") {
    return messages;
  }

  return [{ role: "system", content: systemPrompt }, ...messages];
}

export function serializeHistoryMessages(
  history: readonly MessageWithParts[],
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
  modelOrigin?: ModelOrigin,
): ModelMessage[] {
  return history.flatMap((message) =>
    serializeMessageForLlm(message, activeReasoningByMessageId, modelOrigin),
  );
}

function serializeMessageForLlm(
  message: MessageWithParts,
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
  modelOrigin?: ModelOrigin,
): ModelMessage[] {
  if (message.info.role === "assistant" && message.info.finish === "error") {
    const content = selectFailedHistoryText(message);
    return content === undefined ? [] : [{ role: "assistant", content }];
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
    const serialized = serializeAssistantMessage(
      message,
      parts.filter((part) => !isInterruptionFactPart(part)),
      activeReasoningByMessageId,
      modelOrigin,
    );
    const interruption = selectActiveInterruptionText(parts);
    // The accepted native body and tool roundtrip remain intact. A later
    // cancellation is a separate fact following all corresponding results.
    return interruption === undefined
      ? serialized
      : [...serialized, { role: "assistant", content: interruption }];
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
  modelOrigin?: ModelOrigin,
): ModelMessage[] {
  const projectedToolParts = parts.filter(isToolPart);
  const content = textContentFromParts(parts);

  const nativePart = parts.find((part) => part.type === "model-state");
  let modelState =
    nativePart?.type === "model-state"
      ? ModelStateSchema.parse(nativePart.modelState)
      : undefined;
  if (modelState !== undefined && message.info.time.completed === undefined)
    return [];
  if (
    modelState !== undefined &&
    modelOrigin !== undefined &&
    !sameModelOrigin(modelState.origin, modelOrigin)
  ) {
    if (
      projectedToolParts.some(
        (part) =>
          part.state.status === "pending" || part.state.status === "running",
      )
    )
      throw new Error(
        "Cannot change model source during an unfinished native tool roundtrip",
      );
    modelState = undefined;
  }

  if (projectedToolParts.length === 0) {
    if (modelState !== undefined) {
      const assistant = {
        role: "assistant" as const,
        content: content === "" ? null : content,
        modelState,
      };
      validateNativeProjection(assistant, modelState.output);
      return [assistant];
    }
    return content === "" ? [] : [{ role: "assistant", content }];
  }

  const assistantMessage = {
    role: "assistant",
    ...(modelState === undefined ? {} : { modelState }),
    content: content === "" ? null : content,
    toolCalls: projectedToolParts.map((part) => ({
      callId: part.callId,
      name: part.tool,
      argumentsJson: JSON.stringify(part.state.input),
    })),
  } satisfies ModelMessage;
  if (modelState !== undefined)
    validateNativeProjection(assistantMessage, modelState.output);
  const reasoning =
    nativePart === undefined
      ? activeReasoningByMessageId?.get(message.info.id)
      : undefined;
  const assistantWithReasoning =
    reasoning === undefined || reasoning === ""
      ? assistantMessage
      : ({
          ...assistantMessage,
          reasoningText: reasoning,
        } satisfies ModelMessage);

  return [
    assistantWithReasoning,
    ...projectedToolParts.map((part) => ({
      role: "tool" as const,
      callId: part.callId,
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

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
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
      return INTERRUPTED_TOOL_RESULT;
    case "running":
      return INTERRUPTED_TOOL_RESULT;
  }
}
