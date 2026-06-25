import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { MessageWithParts, Part } from "./types.js";
import { getMessageOrigin } from "./origin.js";

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
  if (part.state.status === "error") {
    return part.state.error;
  }
  if (part.state.status === "aborted") {
    return part.state.output === undefined || part.state.output === ""
      ? part.state.error
      : `${part.state.output}\n\n${part.state.error}`;
  }
  if (part.state.status === "running") {
    return part.state.title ?? "";
  }
  return part.state.raw;
}

function orderMessagesForModel(
  messages: readonly MessageWithParts[],
): readonly MessageWithParts[] {
  const summaries = messages.filter(
    (message) => getMessageOrigin(message) === "summary",
  );
  if (summaries.length === 0) {
    return messages;
  }

  return [
    ...summaries,
    ...messages.filter((message) => getMessageOrigin(message) !== "summary"),
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
