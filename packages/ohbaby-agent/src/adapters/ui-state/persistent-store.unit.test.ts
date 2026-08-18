import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  MessageWithParts,
  ToolState,
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

  it("omits MCP selector calls and results from a persisted transcript", () => {
    const message = {
      ...assistantMessage({ time: { created: 1_000 } }),
      parts: [todoToolPart("message_1", "select_tools")],
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

  it.each([
    [{ exitCode: null, status: "failed" }, "failed"],
    [{ exitCode: null, status: "timed_out" }, "timed out"],
    [{ exitCode: null, status: "cancelled" }, "cancelled"],
    [{ exitCode: 1 }, "exit code 1"],
  ] as const)(
    "folds completed tool metadata into a failed persisted transcript",
    (metadata, expectedError) => {
      const message = messageWithToolState({
        input: { command: "sleep 10" },
        metadata,
        output: "partial output",
        status: "completed",
      });

      expect(messageToUiMessage(message)?.parts).toEqual([
        {
          call: {
            id: "call_bash",
            input: { command: "sleep 10" },
            name: "bash",
            status: "failed",
          },
          type: "tool-call",
        },
        {
          result: {
            callId: "call_bash",
            error: expectedError,
            output: "partial output",
          },
          type: "tool-result",
        },
      ]);
    },
  );

  it("preserves partial output for an aborted tool", () => {
    const message = messageWithToolState({
      error: "Tool execution aborted by user",
      input: { command: "sleep 10" },
      output: "partial output",
      status: "aborted",
    });

    expect(messageToUiMessage(message)?.parts[1]).toEqual({
      result: {
        callId: "call_bash",
        error: "Tool execution aborted by user",
        output: "partial output",
      },
      type: "tool-result",
    });
  });

  it("projects an errored tool with its scheduler message", () => {
    const message = messageWithToolState({
      error: "permission denied",
      input: { path: "/private" },
      status: "error",
    });

    expect(messageToUiMessage(message)?.parts).toEqual([
      {
        call: {
          id: "call_bash",
          input: { path: "/private" },
          name: "bash",
          status: "failed",
        },
        type: "tool-call",
      },
      {
        result: {
          callId: "call_bash",
          error: "permission denied",
          output: "",
        },
        type: "tool-result",
      },
    ]);
  });

  it("keeps a zero-exit completed tool successful", () => {
    const message = messageWithToolState({
      input: { command: "true" },
      metadata: { exitCode: 0, status: "completed" },
      output: "done",
      status: "completed",
    });

    expect(messageToUiMessage(message)?.parts).toEqual([
      {
        call: {
          id: "call_bash",
          input: { command: "true" },
          name: "bash",
          status: "completed",
        },
        type: "tool-call",
      },
      {
        result: { callId: "call_bash", output: "done" },
        type: "tool-result",
      },
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
  tool: "select_tools" | "todo_read" | "todo_write",
): MessageWithParts["parts"][number] {
  return {
    callId: `${messageId}_call_0`,
    id: `${messageId}_part_1`,
    messageId,
    orderIndex: 1,
    sessionId: "session_1",
    state: {
      input:
        tool === "todo_write"
          ? { todos: [] }
          : tool === "select_tools"
            ? { tools: ["mcp_s6_server_t4_echo"] }
            : {},
      output: "No todos.",
      status: "completed",
    },
    tool,
    type: "tool",
  };
}

function messageWithToolState(state: ToolState): MessageWithParts {
  return {
    ...assistantMessage({ time: { created: 1_000 } }),
    parts: [
      {
        callId: "call_bash",
        id: "message_1_part_0",
        messageId: "message_1",
        orderIndex: 0,
        sessionId: "session_1",
        state,
        tool: "bash",
        type: "tool",
      },
    ],
  };
}
