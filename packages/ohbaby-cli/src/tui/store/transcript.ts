import type { UiMessage } from "ohbaby-sdk";
import type { TuiRuntimeStatus } from "./snapshot.js";

export interface TranscriptSplit {
  readonly committedMessages: readonly UiMessage[];
  readonly liveMessage: UiMessage | null;
}

export function splitTranscript(
  messages: readonly UiMessage[],
  runtime: TuiRuntimeStatus,
): TranscriptSplit {
  const last = messages.at(-1);
  if (!last || runtime.kind === "idle" || runtime.kind === "error") {
    return { committedMessages: messages, liveMessage: null };
  }

  if (
    runtime.kind === "waiting-for-permission" &&
    hasPendingOrRunningTool(last)
  ) {
    return liveTail(messages, last);
  }

  if (last.role === "user") {
    return { committedMessages: messages, liveMessage: null };
  }

  const isAssistant = last.role === "assistant";
  if (!isAssistant) {
    return { committedMessages: messages, liveMessage: null };
  }

  if (last.status === "streaming" || hasPendingOrRunningTool(last)) {
    return liveTail(messages, last);
  }

  if (runtime.kind === "running") {
    return liveTail(messages, last);
  }

  return { committedMessages: messages, liveMessage: null };
}

function liveTail(
  messages: readonly UiMessage[],
  liveMessage: UiMessage,
): TranscriptSplit {
  return {
    committedMessages: messages.slice(0, -1),
    liveMessage,
  };
}

function hasPendingOrRunningTool(message: UiMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool-call" &&
      (part.call.status === "pending" || part.call.status === "running"),
  );
}
