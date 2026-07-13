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

  it("omits todo tool calls and results from a persisted transcript", () => {
    const message = {
      ...assistantMessage({ time: { created: 1_000 } }),
      parts: [todoToolPart("message_1", "todo_write")],
    };

    expect(messageToUiMessage(message)).toBeUndefined();
  });

  it("retains ordinary content while filtering todo tool parts", () => {
    const message = {
      ...assistantMessage({ time: { created: 1_000 } }),
      parts: [
        textPart("message_1", "Working on it."),
        todoToolPart("message_1", "todo_read"),
      ],
    };

    expect(messageToUiMessage(message)?.parts).toEqual([
      { text: "Working on it.", type: "text" },
    ]);
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

function todoToolPart(
  messageId: string,
  tool: "todo_read" | "todo_write",
): MessageWithParts["parts"][number] {
  return {
    callId: `${messageId}_call_0`,
    id: `${messageId}_part_1`,
    messageId,
    orderIndex: 1,
    sessionId: "session_1",
    state: {
      input: tool === "todo_write" ? { todos: [] } : {},
      output: "No todos.",
      status: "completed",
    },
    tool,
    type: "tool",
  };
}
