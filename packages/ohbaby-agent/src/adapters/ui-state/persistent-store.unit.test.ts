import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  MessageWithParts,
  TextPart,
  ToolState,
  UserMessage,
} from "../../core/message/index.js";
import { messageToUiMessage, runToUiRun } from "./persistent-store.js";

describe("runToUiRun", () => {
  it.each([
    ["pending", "running", undefined],
    ["running", "running", undefined],
    ["succeeded", "idle", "succeeded"],
    ["failed", "error", "failed"],
    ["cancelled", "idle", "cancelled"],
    ["interrupted", "idle", "interrupted"],
  ] as const)(
    "preserves the ledger outcome for %s",
    (status, kind, outcome) => {
      const run = runToUiRun({
        runId: "r",
        sessionId: "s",
        createdAt: 1,
        triggerSource: "user",
        status,
        error: status === "interrupted" ? "user-stop" : undefined,
      });
      expect(run.trigger).toBe("user");
      expect(run.status.kind).toBe(kind);
      expect(run.outcome).toBe(outcome);
    },
  );
});

describe("messageToUiMessage", () => {
  it("never exposes persisted native state in the UI projection", () => {
    const base = assistantMessage({ time: { created: 1, completed: 2 } });
    const message: MessageWithParts = {
      ...base,
      parts: [
        ...base.parts,
        {
          id: "private",
          messageId: "message_1",
          sessionId: "session_1",
          orderIndex: 9,
          type: "model-state",
          modelState: {
            version: 1,
            origin: {
              provider: "test",
              model: "test",
              protocol: "anthropic",
              endpoint: "https://test",
            },
            output: {
              protocol: "anthropic",
              items: [{ type: "redacted_thinking", data: "private-opaque" }],
            },
            estimate: { tokens: 40, source: "output" },
          },
        },
      ],
    };
    expect(JSON.stringify(messageToUiMessage(message))).not.toContain(
      "private-opaque",
    );
    expect(messageToUiMessage(message)).toEqual(messageToUiMessage(base));
  });

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

  it("hides model-only runtime parts while keeping the user text", () => {
    const info: UserMessage = {
      agent: "default",
      id: "message_user",
      role: "user",
      sessionId: "session_1",
      time: { created: 1_000 },
    };
    const runtimePart = {
      ...textPart(
        "message_user",
        "<environment_context>secret</environment_context>",
      ),
      metadata: { kind: "model-context:runtime:v1" },
      orderIndex: 1,
      synthetic: true,
    } as MessageWithParts["parts"][number];

    expect(
      messageToUiMessage({
        info,
        parts: [textPart("message_user", "hello"), runtimePart],
      })?.parts,
    ).toMatchObject([{ text: "hello", type: "text" }]);
  });

  it("hides trusted reminder parts while preserving user text with the same tags", () => {
    const info: UserMessage = {
      agent: "build",
      id: "reminder",
      role: "user",
      sessionId: "session_1",
      time: { created: 1 },
    };
    const text =
      "<system-reminder>Current working directory: /private</system-reminder>";
    const reminderPart = {
      ...textPart(info.id, text),
      synthetic: true,
      metadata: {
        kind: "system-reminder:v1",
        reminderType: "environment",
        key: "environment-key",
        anchorAssistantId: "owner",
      },
    };
    expect(messageToUiMessage({ info, parts: [reminderPart] })).toBeUndefined();
    expect(
      messageToUiMessage({ info, parts: [textPart(info.id, text)] })?.parts,
    ).toMatchObject([{ type: "text", text }]);
    expect(
      messageToUiMessage({
        info,
        parts: [{ ...reminderPart, synthetic: false }],
      })?.parts,
    ).toMatchObject([{ type: "text", text }]);
    expect(
      messageToUiMessage({
        info,
        parts: [textPart(info.id, "actual request"), reminderPart],
      })?.parts,
    ).toMatchObject([{ type: "text", text: "actual request" }]);
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

    expect(messageToUiMessage(message)?.parts).toMatchObject([
      { text: "Working on it.", type: "text" },
    ]);
  });

  it.each(["todo_read", "todo_write", "select_tools"] as const)(
    "marks a step that called the hidden %s tool (copy improve-2 T5)",
    (tool) => {
      const projected = messageToUiMessage({
        ...assistantMessage({ time: { created: 1_000 } }),
        parts: [
          textPart("message_1", "I will check the private task list."),
          todoToolPart("message_1", tool),
        ],
      });

      expect(projected?.hiddenToolCalls).toBe(true);
      expect(projected?.parts.map((part) => part.type)).toEqual(["text"]);
    },
  );

  it("does not mark plain text or visible tool steps (copy improve-2 T5)", () => {
    const plain = messageToUiMessage({
      ...assistantMessage({ time: { created: 1_000 } }),
      parts: [textPart("message_1", "Done.")],
    });
    const visible = messageToUiMessage(
      messageWithToolState({
        input: { command: "ls" },
        output: "a",
        status: "completed",
      }),
    );

    expect(plain).not.toHaveProperty("hiddenToolCalls");
    expect(visible).not.toHaveProperty("hiddenToolCalls");
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

      expect(messageToUiMessage(message)?.parts).toMatchObject([
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

  it.each(["agent", "subagent_run"])(
    "preserves %s execution identity on the UI result while keeping scheduler metadata",
    (toolName) => {
      const execution = {
        executionId: "historical-execution",
        subagentId: "worker",
        status: "completed",
      };
      const base = messageWithToolState({
        input: {},
        status: "completed",
        output: "answer",
        metadata: { subagent: { execution }, internalDebug: "not for UI" },
      });
      const message: MessageWithParts = {
        ...base,
        parts: base.parts.map((part) =>
          part.type === "tool"
            ? { ...part, tool: toolName, metadata: { sourceOrder: 2 } }
            : part,
        ),
      };
      const result = messageToUiMessage(message)?.parts.find(
        (part) => part.type === "tool-result",
      );
      expect(result?.metadata).toEqual({
        sourceOrder: 2,
        subagent: { execution },
      });
    },
  );

  it("preserves partial output for an aborted tool", () => {
    const message = messageWithToolState({
      error: "Tool execution aborted by user",
      input: { command: "sleep 10" },
      output: "partial output",
      status: "aborted",
    });

    expect(messageToUiMessage(message)?.parts[1]).toMatchObject({
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

    expect(messageToUiMessage(message)?.parts).toMatchObject([
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

    expect(messageToUiMessage(message)?.parts).toMatchObject([
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

function textPart(messageId: string, text: string): TextPart {
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

it("projects automatic runtime input as a system fact while preserving user Steer origin", () => {
  const message = assistantMessage({ time: { created: 1 } });
  const origin = {
    kind: "subagent-result" as const,
    inputId: "input",
    targetRunId: "run",
    sourceId: "execution",
  };
  expect(
    messageToUiMessage({
      ...message,
      info: { ...message.info, runtimeInput: origin },
    })?.role,
  ).toBe("system");
  expect(
    messageToUiMessage({
      ...message,
      info: {
        id: "user",
        sessionId: "root",
        role: "user",
        agent: "main",
        time: { created: 1 },
        runtimeInput: { ...origin, kind: "user-steer" },
      },
    })?.role,
  ).toBe("user");
});

it.each(["subagent-status", "subagent-result", "user-steer"] as const)(
  "preserves %s provenance without changing the durable input",
  (kind) => {
    const message: MessageWithParts = {
      ...assistantMessage({ time: { created: 1 } }),
      info: {
        id: "input",
        sessionId: "root",
        role: "user",
        agent: "main",
        time: { created: 1 },
        runtimeInput: {
          kind,
          inputId: "input",
          targetRunId: "run",
          sourceId: "source",
        },
      },
    };
    expect(messageToUiMessage(message)).toMatchObject({
      runtimeInputKind: kind,
    });
    expect(message.info.role).toBe("user");
    expect(message.parts).toHaveLength(1);
  },
);
