import { describe, expect, it } from "vitest";
import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
import type { TuiRuntimeStatus } from "./snapshot.js";
import {
  advanceTranscriptCommit,
  appendTurnCompletions,
  splitTranscript,
} from "./transcript.js";

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

describe("turn end lines (turn-projection)", () => {
  const prompt: UiPromptSubmission = {
    promptId: "p1",
    clientRequestId: "c1",
    scopeKey: "s",
    sessionId: "s",
    userMessageId: "user",
    text: "Ask",
    status: "succeeded",
    runId: "r1",
    createdAt: "2026-06-07T00:00:00.000Z",
    acceptedAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:02.000Z",
    endedAt: "2026-06-07T00:00:02.000Z",
  };
  const run = (id: string, patch: Partial<UiRun> = {}): UiRun => ({
    id,
    sessionId: "s",
    status: { kind: "idle" },
    startedAt: "2026-06-07T00:01:00.000Z",
    endedAt: "2026-06-07T00:01:04.000Z",
    updatedAt: "2026-06-07T00:01:04.000Z",
    trigger: "subagent",
    outcome: "succeeded",
    ...patch,
  });
  const wakeUps = ["w1", "w2", "w3"];
  const messages: UiMessage[] = [
    userMessage("user", "Ask"),
    assistantMessage("answer", "Started the subagents", { runId: "r1" }),
    ...wakeUps.flatMap((id): UiMessage[] => [
      {
        ...userMessage(`${id}-status`, "status"),
        role: "system",
        runId: id,
        runtimeInputKind: "subagent-status",
      },
      assistantMessage(`${id}-answer`, `Result ${id}`, { runId: id }),
    ]),
  ];
  const runs = [
    run("r1", {
      trigger: "user",
      startedAt: prompt.createdAt,
      endedAt: prompt.endedAt,
    }),
    ...wakeUps.map((id) => run(id)),
  ];
  const restore = () =>
    appendTurnCompletions(
      advanceTranscriptCommit(undefined, messages, idle()).committedItems,
      { sessionId: "s", runs, prompts: [prompt], messages },
      true,
    );

  it("adds one end line per run, labelled when a subagent result started it (T16)", () => {
    const items = restore();
    expect(items.map((item) => item.id)).toEqual([
      "user",
      "answer",
      "turn-completion:r1",
      "w1-answer",
      "turn-completion:w1",
      "w2-answer",
      "turn-completion:w2",
      "w3-answer",
      "turn-completion:w3",
    ]);
    expect(
      items.flatMap((item) =>
        item.turnCompletion ? [item.turnCompletion.trigger] : [],
      ),
    ).toEqual(["user", "subagent", "subagent", "subagent"]);
  });

  it("waits for the prompt before a live user turn gets its end line", () => {
    const live = advanceTranscriptCommit(
      undefined,
      messages.slice(0, 2),
      idle(),
    ).committedItems;
    const session = {
      sessionId: "s",
      runs: runs.slice(0, 1),
      messages: messages.slice(0, 2),
    };
    // The run reports its end before the prompt does.
    const early = appendTurnCompletions(live, {
      ...session,
      prompts: [{ ...prompt, status: "running", endedAt: undefined }],
    });
    expect(early).toBe(live);
    const ended = appendTurnCompletions(early, {
      ...session,
      prompts: [prompt],
    });
    expect(ended.at(-1)?.turnCompletion?.timing).toMatchObject({
      id: "p1",
      startedAt: prompt.acceptedAt,
      endedAt: prompt.endedAt,
    });
  });

  it("never repeats a run and skips runs that wrote nothing visible (T17)", () => {
    const items = restore();
    const again = appendTurnCompletions(
      items,
      {
        sessionId: "s",
        runs: [...runs, run("silent"), run("hidden-only")],
        prompts: [prompt],
        messages: [
          ...messages,
          {
            ...userMessage("hidden", "status"),
            role: "system",
            runId: "hidden-only",
            runtimeInputKind: "subagent-status",
          },
        ],
      },
      true,
    );
    expect(again).toBe(items);
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

describe("internal runtime inputs", () => {
  it("filters sources before choosing the live tail without changing stored messages", () => {
    const live = assistantMessage("answer", "still streaming", {
      status: "streaming",
    });
    const internal: UiMessage = {
      ...userMessage("internal", "private"),
      role: "system",
      runtimeInputKind: "subagent-status",
    };
    const messages = [live, internal];
    expect(splitTranscript(messages, running())).toEqual({
      committedMessages: [],
      liveMessage: live,
    });
    expect(
      advanceTranscriptCommit(undefined, messages, running()).committedItems,
    ).toEqual([]);
    expect(messages).toEqual([live, internal]);
  });
  it("preserves ordinary system, user-steer, user text and assistant quotations", () => {
    const visible: UiMessage[] = [
      { ...userMessage("notice", "normal notice"), role: "system" },
      {
        ...userMessage("steer", "change direction"),
        runtimeInputKind: "user-steer",
      },
      userMessage("user", "subagent-status quoted by user"),
      assistantMessage("quote", "subagent-result quoted by assistant"),
    ];
    const internal: UiMessage[] = ["subagent-status", "subagent-result"].map(
      (kind, index) => ({
        ...userMessage(`internal-${String(index)}`, "private"),
        role: "system",
        runtimeInputKind: kind as "subagent-status" | "subagent-result",
      }),
    );
    expect(
      splitTranscript([...visible, ...internal], idle()).committedMessages,
    ).toEqual(visible);
  });
});
