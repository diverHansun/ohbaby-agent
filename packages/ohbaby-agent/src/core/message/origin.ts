import type { MessageWithParts } from "./types.js";

export const MODEL_CONTEXT_RUNTIME_KIND = "model-context:runtime:v1";

export type MessageOrigin =
  | "assistant"
  | "summary"
  | "system"
  | "tool"
  | "user";

export function getMessageOrigin(message: MessageWithParts): MessageOrigin {
  if (message.parts.some(isContextSummaryPart)) {
    return "summary";
  }
  if (message.parts.some((part) => part.type === "tool")) {
    return "tool";
  }
  return message.info.role;
}

export function isContextSummaryPart(
  part: MessageWithParts["parts"][number],
): boolean {
  return part.type === "text" && part.metadata?.kind === "context-summary";
}

export function isModelContextPart(
  part: MessageWithParts["parts"][number],
): boolean {
  return (
    part.type === "text" &&
    part.synthetic === true &&
    part.metadata?.kind === MODEL_CONTEXT_RUNTIME_KIND
  );
}
