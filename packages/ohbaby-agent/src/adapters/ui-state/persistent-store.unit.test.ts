import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  MessageWithParts,
  UserMessage,
} from "../../core/message/index.js";
import { messageToUiMessage } from "./persistent-store.js";

describe("messageToUiMessage", () => {
  it("maps assistant finish and completion onto the UI message", () => {
    const message = assistantMessage({
      finish: "length",
      time: { completed: 2_000, created: 1_000 },
    });

    const uiMessage = messageToUiMessage(message);

    expect(uiMessage).toMatchObject({
      finishReason: "length",
      id: "message_1",
      role: "assistant",
      status: "completed",
    });
  });

  it("leaves finishReason and status unset for incomplete assistant messages", () => {
    const message = assistantMessage({ time: { created: 1_000 } });

    const uiMessage = messageToUiMessage(message);

    expect(uiMessage?.finishReason).toBeUndefined();
    expect(uiMessage?.status).toBeUndefined();
  });

  it("marks errored assistant messages with error status", () => {
    const message = assistantMessage({
      error: { message: "aborted", name: "MessageAbortedError" },
      time: { completed: 2_000, created: 1_000 },
    });

    const uiMessage = messageToUiMessage(message);

    expect(uiMessage?.status).toBe("error");
  });

  it("does not attach finish metadata to user messages", () => {
    const info: UserMessage = {
      agent: "default",
      id: "message_user",
      role: "user",
      sessionId: "session_1",
      time: { created: 1_000 },
    };
    const message: MessageWithParts = {
      info,
      parts: [textPart("message_user", "hello")],
    };

    const uiMessage = messageToUiMessage(message);

    expect(uiMessage?.finishReason).toBeUndefined();
    expect(uiMessage?.status).toBeUndefined();
  });
});

function assistantMessage(
  patch: Partial<AssistantMessage> & Pick<AssistantMessage, "time">,
): MessageWithParts {
  const info: AssistantMessage = {
    agent: "default",
    id: "message_1",
    role: "assistant",
    sessionId: "session_1",
    ...patch,
  };
  return {
    info,
    parts: [textPart("message_1", "partial answer")],
  };
}

function textPart(
  messageId: string,
  text: string,
): MessageWithParts["parts"][number] {
  return {
    id: `${messageId}_part_0`,
    messageId,
    orderIndex: 0,
    sessionId: "session_1",
    text,
    type: "text",
  };
}
