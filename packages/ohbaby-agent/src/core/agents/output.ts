import type { MessageWithParts } from "../message/index.js";

function textFromMessage(message: MessageWithParts): string {
  return message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("");
}

export function extractFinalOutput(
  messages: readonly MessageWithParts[],
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.info.role !== "assistant") {
      continue;
    }
    const text = textFromMessage(message);
    if (text.trim().length > 0) {
      return text;
    }
  }

  return "";
}
