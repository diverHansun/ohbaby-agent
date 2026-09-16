import type { MessageWithParts, Part, ToolPart } from "../message/index.js";
import { isModelContextPart } from "../message/origin.js";
import { isActivePart } from "./filters.js";
import { isSummaryMessage } from "./summary.js";
import { formatToolResultContentForModel } from "./tool-metadata-projection.js";

export interface SerializeHistoryOptions {
  readonly includeModelContext?: boolean;
  /** Summary-only tool facts; leave disabled for existing compaction scoring. */
  readonly includeToolContext?: boolean;
}

/**
 * @deprecated Use isSummaryMessage from ./summary.js.
 */
export function isContextSummary(message: MessageWithParts): boolean {
  return isSummaryMessage(message);
}

export function serializePart(part: Part): string {
  if (!isActivePart(part)) {
    return "";
  }
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "reasoning" || part.type === "model-state") {
    return "";
  }
  if (part.state.status === "completed") {
    return part.state.output;
  }
  if (part.state.status === "error" || part.state.status === "aborted") {
    return part.state.error;
  }
  if (part.state.status === "running") {
    return part.state.title ?? "";
  }
  return part.state.raw;
}

function serializeSummaryTool(part: ToolPart): string {
  const { state } = part;
  const action = JSON.stringify({
    tool: part.tool,
    callId: part.callId,
    input: state.input,
    status: state.status,
  });
  if (state.status === "pending" || state.status === "running") {
    return `${action}\nResult unknown; execution may have had side effects.`;
  }
  const content =
    state.status === "completed"
      ? state.output
      : state.status === "aborted"
        ? [state.output, state.error].filter(Boolean).join("\n\n")
        : state.error;
  const result = formatToolResultContentForModel({
    tool: part.tool,
    content,
    metadata: state.metadata,
  });
  return result === "" ? action : `${action}\n${result}`;
}

export function serializeMessage(
  message: MessageWithParts,
  options: SerializeHistoryOptions = {},
): string {
  const parts = message.parts
    .filter(
      (part) =>
        options.includeModelContext !== false || !isModelContextPart(part),
    )
    .map((part) =>
      options.includeToolContext === true &&
      part.type === "tool" &&
      isActivePart(part)
        ? serializeSummaryTool(part)
        : serializePart(part),
    )
    .filter(Boolean)
    .join("\n");
  return parts ? `${message.info.role}: ${parts}` : message.info.role;
}

export function serializeHistory(
  history: readonly MessageWithParts[],
  options: SerializeHistoryOptions = {},
): string {
  return history
    .map((message) => serializeMessage(message, options))
    .join("\n\n");
}

export function getCompletedToolOutput(part: Part): string | undefined {
  const state = part.type === "tool" ? part.state : undefined;
  if (state?.status === "completed" && part.time?.compacted === undefined) {
    return state.output;
  }

  return undefined;
}
