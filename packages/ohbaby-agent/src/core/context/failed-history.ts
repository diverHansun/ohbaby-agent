import {
  INTERRUPTION_TEXT,
  isInterruptionFactPart,
  isVisibleAssistantTextPart,
} from "../message/interruption.js";
import type { MessageWithParts, Part } from "../message/types.js";
import { isActivePart } from "./filters.js";

/** A persisted carrier controls when a bodyless interruption fact retires. */
export function selectActiveInterruptionText(
  parts: readonly Part[],
): string | undefined {
  const fact = parts.find(
    (part) =>
      isInterruptionFactPart(part) &&
      isActivePart(part) &&
      !part.ignored &&
      part.text !== "",
  );
  return fact?.type === "text" ? fact.text : undefined;
}

/** Project failed output as plain history without replaying tools or native state. */
export function selectFailedHistoryText(
  message: MessageWithParts,
): string | undefined {
  if (message.info.role !== "assistant" || message.info.finish !== "error")
    return undefined;

  const reason = message.info.error?.name;
  switch (reason) {
    case "MessageAbortedError":
      return selectActiveInterruptionText(message.parts);
    case "MessageOutputLengthError":
    case "MessageContentFilterError":
    case "MessageStreamInterruptedError": {
      const body = message.parts
        .filter(isVisibleAssistantTextPart)
        .map((part) => part.text)
        .join("");
      return body === ""
        ? selectActiveInterruptionText(message.parts)
        : `${INTERRUPTION_TEXT[reason]}\n${body}`;
    }
    default:
      return undefined;
  }
}
