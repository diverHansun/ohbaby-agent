import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import {
  createInitialViewState,
  reduceUiEvent,
  replaceSnapshot,
} from "./eventReducer.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function emptySnapshot(): UiSnapshot {
  return {
    activeSessionId: "session_1",
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: timestamp,
        id: "session_1",
        messages: [],
        title: "Session",
        updatedAt: timestamp,
      },
    ],
    status: { kind: "idle" },
  };
}

describe("ohbaby-web eventReducer", () => {
  it("upserts prompt submissions and updates by stable prompt id", () => {
    let state = replaceSnapshot(emptySnapshot(), 0);
    const prompt = {
      clientRequestId: "request_1",
      createdAt: timestamp,
      promptId: "prompt_1",
      scopeKey: "/repo",
      sessionId: "session_1",
      status: "queued" as const,
      text: "queued",
      updatedAt: timestamp,
      userMessageId: "message_1",
    };
    state = reduceUiEvent(state, { prompt, type: "prompt.submitted" }, 1);
    state = reduceUiEvent(
      state,
      {
        prompt: {
          ...prompt,
          status: "starting",
          updatedAt: "2026-06-12T00:00:01.000Z",
        },
        type: "prompt.updated",
      },
      2,
    );

    expect(state.snapshot?.prompts).toEqual([
      expect.objectContaining({ promptId: "prompt_1", status: "starting" }),
    ]);
  });

  it("replaces the snapshot and records the sequence baseline", () => {
    const state = replaceSnapshot(emptySnapshot(), 10);

    expect(state).toMatchObject({
      commandCatalogVersion: null,
      lastAppliedSeqNum: 10,
      snapshot: {
        activeSessionId: "session_1",
      },
    });
  });

  it("records command catalog updates for UI refetch", () => {
    const state = reduceUiEvent(
      replaceSnapshot(emptySnapshot(), 0),
      {
        reason: "test",
        timestamp: Date.parse(timestamp),
        type: "command.catalog.updated",
        version: "commands-v2",
      },
      1,
    );

    expect(state).toMatchObject({
      commandCatalogVersion: "commands-v2",
      lastAppliedSeqNum: 1,
    });
  });

  it("tracks goal updates in the snapshot contract", () => {
    let state = replaceSnapshot(emptySnapshot(), 0);

    state = reduceUiEvent(
      state,
      {
        goal: {
          objective: "finish backend contract",
          pauseReason: "interrupted",
          status: "paused",
        },
        sessionId: "session_1",
        type: "goal.updated",
      },
      1,
    );

    expect(state.snapshot?.goals).toMatchObject([
      {
        goal: {
          objective: "finish backend contract",
          status: "paused",
        },
        sessionId: "session_1",
      },
    ]);

    state = reduceUiEvent(
      state,
      {
        goal: null,
        sessionId: "session_1",
        type: "goal.updated",
      },
      2,
    );

    expect(state.snapshot?.goals).toEqual([]);
  });

  it("upserts todo projections by session without changing other sessions", () => {
    let state = replaceSnapshot(
      {
        ...emptySnapshot(),
        todos: [
          {
            sessionId: "session_other",
            todos: [{ content: "Keep me", status: "pending" }],
            visible: true,
          },
        ],
      },
      0,
    );

    state = reduceUiEvent(
      state,
      {
        sessionId: "session_1",
        timestamp: 1,
        todos: [{ content: "Implement dock", status: "in_progress" }],
        type: "todo.updated",
        visible: true,
      },
      1,
    );
    state = reduceUiEvent(
      state,
      {
        sessionId: "session_1",
        timestamp: 2,
        todos: [{ content: "Implement dock", status: "completed" }],
        type: "todo.updated",
        visible: false,
      },
      2,
    );

    expect(state.snapshot?.todos).toEqual([
      {
        sessionId: "session_other",
        todos: [{ content: "Keep me", status: "pending" }],
        visible: true,
      },
      {
        sessionId: "session_1",
        todos: [{ content: "Implement dock", status: "completed" }],
        visible: false,
      },
    ]);
  });

  it("accumulates streaming deltas until a finalized message arrives", () => {
    let state = replaceSnapshot(emptySnapshot(), 0);

    state = reduceUiEvent(
      state,
      {
        delta: "hel",
        messageId: "message_1",
        sessionId: "session_1",
        type: "message.part.delta",
      },
      1,
    );
    state = reduceUiEvent(
      state,
      {
        delta: "lo",
        messageId: "message_1",
        sessionId: "session_1",
        type: "message.part.delta",
      },
      2,
    );

    expect(state.snapshot?.sessions[0]?.messages[0]?.parts).toEqual([
      { text: "hello", type: "text" },
    ]);

    state = reduceUiEvent(
      state,
      {
        message: {
          completedAt: timestamp,
          createdAt: timestamp,
          id: "message_1",
          parts: [{ text: "hello!", type: "text" }],
          role: "assistant",
          status: "completed",
        },
        sessionId: "session_1",
        type: "message.updated",
      },
      3,
    );

    expect(state.snapshot?.sessions[0]?.messages[0]?.parts).toEqual([
      { text: "hello!", type: "text" },
    ]);
  });

  it("tracks reasoning as transient state without mutating snapshot message parts", () => {
    let state = replaceSnapshot(
      {
        ...emptySnapshot(),
        sessions: [
          {
            ...emptySnapshot().sessions[0],
            messages: [
              {
                createdAt: timestamp,
                id: "message_1",
                parts: [],
                role: "assistant",
                status: "streaming",
              },
            ],
          },
        ],
      },
      0,
    );

    state = reduceUiEvent(
      state,
      {
        content: "thinking",
        delta: "thinking",
        messageId: "message_1",
        sessionId: "session_1",
        type: "message.reasoning.delta",
      },
      1,
    );

    expect(state.reasoningByMessageId).toEqual({
      message_1: { content: "thinking", folded: false },
    });
    expect(state.snapshot?.sessions[0]?.messages[0]?.parts).toEqual([]);

    state = reduceUiEvent(
      state,
      {
        content: "thinking",
        messageId: "message_1",
        sessionId: "session_1",
        type: "message.reasoning.end",
      },
      2,
    );

    expect(state.reasoningByMessageId).toEqual({
      message_1: { content: "thinking", folded: true },
    });

    state = replaceSnapshot(emptySnapshot(), 3);

    expect(state.reasoningByMessageId).toEqual({});
  });

  it("removes the anonymous streaming placeholder when the final message uses a stable id", () => {
    let state = replaceSnapshot(emptySnapshot(), 0);

    state = reduceUiEvent(
      state,
      {
        delta: "draft",
        sessionId: "session_1",
        type: "message.part.delta",
      },
      1,
    );
    expect(
      state.snapshot?.sessions[0]?.messages.map((message) => message.id),
    ).toEqual(["streaming:session_1"]);

    state = reduceUiEvent(
      state,
      {
        message: {
          completedAt: timestamp,
          createdAt: timestamp,
          id: "message_1",
          parts: [{ text: "final", type: "text" }],
          role: "assistant",
          status: "completed",
        },
        sessionId: "session_1",
        type: "message.updated",
      },
      2,
    );

    expect(state.snapshot?.sessions[0]?.messages).toMatchObject([
      {
        id: "message_1",
        parts: [{ text: "final", type: "text" }],
      },
    ]);
  });

  it("ignores duplicate or older sequence numbers", () => {
    let state = replaceSnapshot(emptySnapshot(), 5);

    state = reduceUiEvent(
      state,
      {
        session: {
          createdAt: timestamp,
          id: "session_2",
          messages: [],
          title: "Ignored",
          updatedAt: timestamp,
        },
        type: "session.updated",
      },
      5,
    );

    expect(state.snapshot?.sessions).toHaveLength(1);
  });

  it("advances the cursor even if no snapshot has loaded yet", () => {
    const state = reduceUiEvent(
      createInitialViewState(),
      {
        status: { kind: "idle" },
        type: "runtime.updated",
      },
      1,
    );

    expect(state).toEqual({
      commandCatalogVersion: null,
      commandNotices: [],
      lastAppliedSeqNum: 1,
      reasoningByMessageId: {},
      snapshot: null,
    });
  });

  it("records command notices even if no snapshot has loaded yet", () => {
    const state = reduceUiEvent(
      createInitialViewState(),
      {
        command: {
          clientInvocationId: "invoke_status",
          commandId: "status",
          commandRunId: "command_1",
          path: ["status"],
          surface: "tui",
        },
        timestamp: Date.parse(timestamp),
        type: "command.started",
      },
      1,
    );

    expect(state).toMatchObject({
      commandNotices: [
        {
          commandId: "status",
          id: "command_1",
          kind: "running",
        },
      ],
      lastAppliedSeqNum: 1,
      snapshot: null,
    });
  });

  it("projects slash command lifecycle events into command notices", () => {
    let state = replaceSnapshot(emptySnapshot(), 0);

    state = reduceUiEvent(
      state,
      {
        command: {
          clientInvocationId: "invoke_status",
          commandId: "status",
          commandRunId: "command_1",
          path: ["status"],
          surface: "tui",
        },
        timestamp: Date.parse(timestamp),
        type: "command.started",
      },
      1,
    );

    expect(state.commandNotices).toMatchObject([
      {
        commandId: "status",
        id: "command_1",
        kind: "running",
        path: ["status"],
      },
    ]);

    state = reduceUiEvent(
      state,
      {
        clientInvocationId: "invoke_status",
        commandRunId: "command_1",
        output: {
          data: {
            permission: { level: "default", mode: "auto" },
            sessionId: "session_1",
          },
          kind: "data",
          subject: "status",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      },
      2,
    );

    expect(state.commandNotices).toMatchObject([
      {
        commandId: "status",
        id: "command_1",
        kind: "success",
        output: {
          data: {
            permission: { level: "default", mode: "auto" },
            sessionId: "session_1",
          },
          kind: "data",
          subject: "status",
        },
        text: "status\nsession: session_1\npermission: auto · default",
      },
    ]);
  });

  it("switches active session when a command result selects a session", () => {
    let state = replaceSnapshot(
      {
        ...emptySnapshot(),
        activeSessionId: "session_1",
        sessions: [
          ...emptySnapshot().sessions,
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [],
            title: "Session 2",
            updatedAt: timestamp,
          },
        ],
      },
      0,
    );

    state = reduceUiEvent(
      state,
      {
        action: {
          data: { choiceId: "session_2" },
          kind: "session.selected",
        },
        clientInvocationId: "invoke_new",
        commandRunId: "command_new",
        output: {
          data: { sessionId: "session_2" },
          kind: "data",
          subject: "session.current",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      },
      1,
    );

    expect(state.snapshot?.activeSessionId).toBe("session_2");
    expect(state.commandNotices).toMatchObject([
      {
        id: "command_new",
        kind: "success",
      },
    ]);
  });

  it("projects slash command failures into command notices", () => {
    const state = reduceUiEvent(
      replaceSnapshot(emptySnapshot(), 0),
      {
        clientInvocationId: "invoke_bad",
        commandRunId: "command_bad",
        error: {
          code: "COMMAND_NOT_FOUND",
          message: "Unknown command",
          recoverable: true,
        },
        timestamp: Date.parse(timestamp),
        type: "command.failed",
      },
      1,
    );

    expect(state.commandNotices).toEqual([
      {
        commandId: "command_bad",
        createdAt: timestamp,
        id: "command_bad",
        kind: "error",
        path: [],
        text: "Unknown command",
      },
    ]);
  });

  it("filters unsupported commands from help command notices", () => {
    const state = reduceUiEvent(
      replaceSnapshot(emptySnapshot(), 0),
      {
        clientInvocationId: "invoke_help",
        commandRunId: "command_help",
        output: {
          data: {
            commands: [
              {
                description: "Show backend status",
                id: "status",
                path: ["status"],
              },
              {
                description: "Browse sessions",
                id: "sessions",
                path: ["sessions"],
              },
              {
                description: "Compact current session",
                id: "compact",
                path: ["compact"],
              },
            ],
          },
          kind: "data",
          subject: "help",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      },
      1,
    );

    expect(state.commandNotices).toMatchObject([
      {
        kind: "success",
        text: "/status - Show backend status",
      },
    ]);
  });
});
