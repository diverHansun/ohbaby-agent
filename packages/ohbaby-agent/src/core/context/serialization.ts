import type { MessageWithParts, Part } from "../message/index.js";

export function isContextSummary(message: MessageWithParts): boolean {
  return message.parts.some(
    (part) => part.type === "text" && part.metadata?.kind === "context-summary",
  );
}

export function serializePart(part: Part): string {
  if (part.time?.compacted !== undefined) {
    return "";
  }
  if (part.type === "text" || part.type === "reasoning") {
    return part.text;
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
