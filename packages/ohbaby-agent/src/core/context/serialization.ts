import type { MessageWithParts, Part } from "../message/index.js";
import { isActivePart } from "./filters.js";
import { isSummaryMessage } from "./summary.js";

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
  if (part.type === "reasoning") {
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

export function serializeMessage(message: MessageWithParts): string {
  const parts = message.parts.map(serializePart).filter(Boolean).join("\n");
  return parts ? `${message.info.role}: ${parts}` : message.info.role;
}

export function serializeHistory(history: readonly MessageWithParts[]): string {
  return history.map(serializeMessage).join("\n\n");
}

export function getCompletedToolOutput(part: Part): string | undefined {
  const state = part.type === "tool" ? part.state : undefined;
  if (state?.status === "completed" && part.time?.compacted === undefined) {
    return state.output;
  }

  return undefined;
}
