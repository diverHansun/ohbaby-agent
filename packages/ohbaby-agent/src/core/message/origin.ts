import type { MessageWithParts } from "./types.js";

export const MODEL_CONTEXT_RUNTIME_KIND = "model-context:runtime:v1";
export const SYSTEM_REMINDER_KIND = "system-reminder:v1";

export type MessageOrigin =
  | "reminder"
  | "runtime"
  | "assistant"
  | "summary"
  | "system"
  | "tool"
  | "user";

export function getMessageOrigin(message: MessageWithParts): MessageOrigin {
  if (isSystemReminderMessage(message)) return "reminder";
  if (
    message.info.runtimeInput &&
    message.info.runtimeInput.kind !== "user-steer"
  )
    return "runtime";
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

export function isSystemReminderPart(
  part: MessageWithParts["parts"][number],
): boolean {
  return (
    part.type === "text" &&
    part.synthetic === true &&
    part.metadata?.kind === SYSTEM_REMINDER_KIND &&
    typeof part.metadata.anchorAssistantId === "string" &&
    part.metadata.anchorAssistantId.length > 0 &&
    typeof part.metadata.reminderType === "string" &&
    typeof part.metadata.key === "string"
  );
}

/** A host reminder message: user role, and every part is a reminder part. */
export function isSystemReminderMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every(
      (part) =>
        isSystemReminderPart(part) &&
        part.metadata?.anchorAssistantId ===
          message.parts[0]?.metadata?.anchorAssistantId,
    )
  );
}

export function getReminderAnchorId(
  message: MessageWithParts,
): string | undefined {
  if (!isSystemReminderMessage(message)) return undefined;
  const anchor = message.parts[0]?.metadata?.anchorAssistantId;
  return typeof anchor === "string" ? anchor : undefined;
}
