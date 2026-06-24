import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MessageWithParts, Part } from "./types.js";

function isContextSummary(message: MessageWithParts): boolean {
  return message.parts.some(
    (part) => part.type === "text" && part.metadata?.kind === "context-summary",
  );
}

function partToContent(part: Part): string {
  if (part.time?.compacted !== undefined) {
    return "";
  }
  if (part.type === "text") {
    return part.ignored ? "" : part.text;
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

function orderMessagesForModel(
  messages: readonly MessageWithParts[],
): readonly MessageWithParts[] {
  const summaries = messages.filter(isContextSummary);
  if (summaries.length === 0) {
    return messages;
  }

  return [
    ...summaries,
    ...messages.filter((message) => !isContextSummary(message)),
  ];
}

export function toModelMessages(
  messages: readonly MessageWithParts[],
): ChatCompletionMessage[] {
  return orderMessagesForModel(messages).flatMap((message) => {
    const content = message.parts.map(partToContent).join("");

    if (content === "") {
      return [];
    }

    return [{ role: message.info.role, content }];
  });
}
