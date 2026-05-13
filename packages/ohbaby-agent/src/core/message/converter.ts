import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MessageWithParts } from "./types.js";

export function toModelMessages(
  messages: readonly MessageWithParts[],
): ChatCompletionMessage[] {
  return messages.flatMap((message) => {
    const content = message.parts
      .map((part) => {
        if (part.type === "text" && !part.ignored) {
          return part.text;
        }
        if (part.type === "reasoning") {
          return part.text;
        }
        return "";
      })
      .join("");

    if (content === "") {
      return [];
    }

    return [{ role: message.info.role, content }];
  });
}
