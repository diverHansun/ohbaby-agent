import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import type { TuiRuntimeStatus } from "./snapshot.js";
import { splitTranscript } from "./transcript.js";

describe("splitTranscript", () => {
  it("keeps an empty transcript fully committed", () => {
    expect(splitTranscript([], idle())).toEqual({
      committedMessages: [],
      liveMessage: null,
    });
  });

  it("keeps completed messages committed while idle", () => {
    const messages = [
      userMessage("user_1", "inspect this"),
      assistantMessage("assistant_1", "done", { status: "completed" }),
    ];

    expect(splitTranscript(messages, idle())).toEqual({
      committedMessages: messages,
      liveMessage: null,
    });
  });

  it("puts a streaming assistant tail into live while running", () => {
    const committed = [userMessage("user_1", "inspect this")];
    const live = assistantMessage("assistant_1", "working", {
      status: "streaming",
    });

    expect(splitTranscript([...committed, live], running())).toEqual({
      committedMessages: committed,
      liveMessage: live,
    });
  });

  it("keeps a just-submitted user message committed while running", () => {
    const messages = [userMessage("user_1", "inspect this")];

    expect(splitTranscript(messages, running())).toEqual({
      committedMessages: messages,
      liveMessage: null,
    });
  });

  it("keeps waiting user and completed assistant messages committed", () => {
    const userMessages = [userMessage("user_1", "approve?")];
    expect(splitTranscript(userMessages, waitingForPermission())).toEqual({
      committedMessages: userMessages,
      liveMessage: null,
    });

    const assistantMessages = [
      userMessage("user_1", "inspect this"),
      assistantMessage("assistant_1", "done", { status: "completed" }),
    ];
    expect(splitTranscript(assistantMessages, waitingForPermission())).toEqual({
      committedMessages: assistantMessages,
      liveMessage: null,
    });
  });

  it("puts a pending or running tool tail into live while waiting for permission", () => {
    const committed = [userMessage("user_1", "run tests")];
    const pendingTool = assistantMessage("assistant_1", "", {
      parts: [
        {
          call: {
            id: "call_1",
            input: { command: "pnpm test" },
            name: "bash",
            status: "pending",
          },
          type: "tool-call",
        },
      ],
      status: "streaming",
    });

    expect(
      splitTranscript([...committed, pendingTool], waitingForPermission()),
    ).toEqual({
      committedMessages: committed,
      liveMessage: pendingTool,
    });
  });

  it("prioritizes pending or running tool tails over the message role while waiting", () => {
    const committed = [userMessage("user_1", "run tests")];
    const toolTail = userMessage("user_tool_tail", "");
    const runningToolTail: UiMessage = {
      ...toolTail,
      parts: [
        {
          call: {
            id: "call_1",
            input: { command: "pnpm test" },
            name: "bash",
            status: "running",
          },
          type: "tool-call",
        },
      ],
    };

    expect(
      splitTranscript([...committed, runningToolTail], waitingForPermission()),
    ).toEqual({
      committedMessages: committed,
      liveMessage: runningToolTail,
    });
  });

  it("keeps a completed assistant tail live while the run has not finished", () => {
    const committed = [userMessage("user_1", "inspect this")];
    const assistant = assistantMessage("assistant_1", "done", {
      status: "completed",
    });

    expect(splitTranscript([...committed, assistant], running())).toEqual({
      committedMessages: committed,
      liveMessage: assistant,
    });
  });

  it("does not split message parts even when text follows a tool result", () => {
    const committed = [userMessage("user_1", "read it")];
    const assistant = assistantMessage("assistant_1", "", {
      parts: [
        { text: "Before tool", type: "text" },
        {
          call: {
            id: "call_1",
            input: { file_path: "README.md" },
            name: "read",
            status: "completed",
          },
          type: "tool-call",
        },
        {
          result: {
            callId: "call_1",
            output: "contents",
          },
          type: "tool-result",
        },
        { text: "After tool", type: "text" },
      ],
      status: "streaming",
    });

    expect(splitTranscript([...committed, assistant], running())).toEqual({
      committedMessages: committed,
      liveMessage: assistant,
    });
  });
});

function idle(): TuiRuntimeStatus {
  return { kind: "idle" };
}

function running(): TuiRuntimeStatus {
  return { kind: "running", runId: "run_1" };
}

function waitingForPermission(): TuiRuntimeStatus {
  return { kind: "waiting-for-permission", requestId: "permission_1" };
}

function userMessage(id: string, text: string): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:00.000Z",
    id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
}

function assistantMessage(
  id: string,
  text: string,
  overrides: Partial<UiMessage> = {},
): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:01.000Z",
    id,
    parts: text === "" ? [] : [{ text, type: "text" }],
    role: "assistant",
    ...overrides,
  };
}
