import { describe, expect, it } from "vitest";
import type {
  UiCommandOutput,
  UiContextWindowUsage,
  UiMessage,
  UiSnapshot,
} from "ohbaby-sdk";
import { selectActiveContextWindowUsage } from "./selectors.js";
import {
  applyTuiEvent,
  createStateFromSnapshot,
  createTuiStore,
  setCommandCatalog,
} from "./events.js";
import type { TuiCommandCatalog, TuiStoreState } from "./snapshot.js";

function snapshot(): UiSnapshot {
  return {
    activeSessionId: "session_1",
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: "2026-05-14T00:00:00.000Z",
        id: "session_1",
        messages: [
          {
            createdAt: "2026-05-14T00:00:01.000Z",
            id: "message_1",
            parts: [{ text: "Hello", type: "text" }],
            role: "assistant",
          },
        ],
        title: "Main",
        updatedAt: "2026-05-14T00:00:02.000Z",
      },
    ],
    status: { kind: "idle" },
  };
}

function contextWindowUsage(
  sessionId: string,
  currentTokens: number,
): UiContextWindowUsage {
  return {
    contextWindowRatio: currentTokens / 1_000_000,
    contextWindowTokens: 1_000_000,
    currentTokens,
    estimatedAt: "2026-06-06T00:00:00.000Z",
    modelId: "fake-model",
    sessionId,
  };
}

function snapshotWithTranscript(input: {
  readonly messages: readonly UiMessage[];
  readonly status: UiSnapshot["status"];
}): UiSnapshot {
  return {
    ...snapshot(),
    sessions: [
      {
        ...snapshot().sessions[0],
        messages: input.messages,
      },
    ],
    status: input.status,
  };
}

function userMessage(id: string, text: string): UiMessage {
  return {
    createdAt: "2026-05-14T00:00:01.000Z",
    id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
}

function assistantMessage(
  id: string,
  text: string,
  patch: Partial<UiMessage> = {},
): UiMessage {
  return {
    createdAt: "2026-05-14T00:00:02.000Z",
    id,
    parts: text === "" ? [] : [{ text, type: "text" }],
    role: "assistant",
    ...patch,
  };
}

function catalog(version = "v1"): TuiCommandCatalog {
  return {
    commands: [
      {
        argumentMode: "argv",
        category: "model",
        description: "Show current model",
        id: "models",
        path: ["models"],
        source: "builtin",
        surfaces: ["tui"],
      },
    ],
    version,
  };
}

function applyCommandOutput(
  state: TuiStoreState,
  output: UiCommandOutput,
  commandId: string,
  timestamp = 1,
): TuiStoreState {
  return applyTuiEvent(state, {
    clientInvocationId: `invoke_${commandId}`,
    commandRunId: `command_${commandId}`,
    output,
    timestamp,
    type: "command.result.delivered",
  });
}

function latestCommandNoticeText(state: TuiStoreState): string | undefined {
  return state.commandNotices.at(-1)?.text;
}

describe("TUI store event reducer", () => {
  it("formats connect command output without exposing internal context window source", () => {
    const state = applyCommandOutput(
      createStateFromSnapshot(snapshot()),
      {
        data: {
          result: {
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://zenmux.ai/api/anthropic",
            contextWindowSource: "detected",
            contextWindowTokens: 262_144,
            interfaceProvider: "anthropic",
            model: "moonshotai/kimi-k2.6",
            provider: "zenmux",
            saved: true,
          },
        },
        kind: "data",
        subject: "model.connected",
      },
      "connect",
    );

    expect(latestCommandNoticeText(state)).toContain("model connected:");
    expect(latestCommandNoticeText(state)).toContain("moonshotai/kimi-k2.6");
    expect(latestCommandNoticeText(state)).toContain("262,144");
    expect(latestCommandNoticeText(state)).not.toContain("contextWindowSource");
    expect(latestCommandNoticeText(state)).not.toContain("detected");
  });

  it("formats connect warnings without exposing internal context window source", () => {
    const state = applyCommandOutput(
      createStateFromSnapshot(snapshot()),
      {
        data: {
          result: {
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://zenmux.ai/api/anthropic",
            contextWindowSource: "default",
            contextWindowTokens: 128_000,
            interfaceProvider: "anthropic",
            model: "moonshotai/kimi-k2.6",
            provider: "zenmux",
            saved: true,
            warning:
              "Unable to detect model context window from metadata; using the configured fallback.",
          },
        },
        kind: "data",
        subject: "model.connected",
      },
      "connect",
    );

    expect(latestCommandNoticeText(state)).toContain(
      "warning: Unable to detect",
    );
    expect(latestCommandNoticeText(state)).not.toContain("contextWindowSource");
    expect(latestCommandNoticeText(state)).not.toContain("default");
  });

  it("projects the active session messages from the initial snapshot", () => {
    const state = createStateFromSnapshot({
      ...snapshot(),
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
    });

    expect(state.activeSessionId).toBe("session_1");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
    expect(state.runtime).toEqual({ kind: "idle" });
    expect(state.permission).toEqual({
      level: "default",
      mode: "auto",
      sessionRules: [],
    });
  });

  it("projects committed transcript slices from the initial snapshot", () => {
    const messages = [
      userMessage("user_1", "inspect this"),
      assistantMessage("assistant_1", "working", {
        status: "streaming",
      }),
    ];
    const state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages,
        status: { kind: "running", runId: "run_1" },
      }),
    );

    expect(state.committedItems.map((item) => item.message)).toEqual([
      messages[0],
    ]);
    expect(state.liveMessage).toEqual(messages[1]);
  });

  it("keeps user messages committed while a run is active", () => {
    const messages = [userMessage("user_1", "inspect this")];
    const state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages,
        status: { kind: "running", runId: "run_1" },
      }),
    );

    expect(state.committedItems.map((item) => item.message)).toEqual(messages);
    expect(state.liveMessage).toBeNull();
  });

  it("keeps committed transcript references stable across message deltas", () => {
    const committed = userMessage("user_1", "inspect this");
    const live = assistantMessage("assistant_1", "Hello", {
      status: "streaming",
    });
    let state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages: [committed, live],
        status: { kind: "running", runId: "run_1" },
      }),
    );
    const committedRef = state.committedItems;

    for (let index = 0; index < 100; index += 1) {
      state = applyTuiEvent(state, {
        content: `Hello ${String(index)}`,
        delta: "x",
        messageId: "assistant_1",
        sessionId: "session_1",
        type: "message.part.delta",
      });
    }

    expect(state.committedItems).toBe(committedRef);
    expect(state.liveMessage?.parts[0]).toMatchObject({ text: "Hello 99" });
  });

  it("tracks reasoning as transient view state without mutating message parts", () => {
    const committed = userMessage("user_1", "inspect this");
    const live = assistantMessage("assistant_1", "", {
      status: "streaming",
    });
    let state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages: [committed, live],
        status: { kind: "running", runId: "run_1" },
      }),
    );

    state = applyTuiEvent(state, {
      content: "thinking",
      delta: "thinking",
      messageId: "assistant_1",
      sessionId: "session_1",
      type: "message.reasoning.delta",
    });

    expect(state.messages[1].parts).toEqual([]);
    expect(state.liveMessage?.parts).toEqual([]);
    expect(state.reasoningByMessageId).toEqual({
      assistant_1: { content: "thinking", folded: false },
    });

    state = applyTuiEvent(state, {
      content: "thinking",
      messageId: "assistant_1",
      sessionId: "session_1",
      type: "message.reasoning.end",
    });

    expect(state.messages[1].parts).toEqual([]);
    expect(state.reasoningByMessageId).toEqual({
      assistant_1: { content: "thinking", folded: true },
    });

    state = applyTuiEvent(state, {
      content: "Answer",
      delta: "Answer",
      messageId: "assistant_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[1].parts).toEqual([{ text: "Answer", type: "text" }]);
    expect(state.reasoningByMessageId).toEqual({
      assistant_1: { content: "thinking", folded: true },
    });

    state = applyTuiEvent(state, {
      status: { kind: "idle" },
      timestamp: 2,
      type: "runtime.updated",
    });

    expect(state.reasoningByMessageId).toEqual({});
    expect(state.committedItems.at(-1)?.message.parts).toEqual([
      { text: "Answer", type: "text" },
    ]);
  });

  it("keeps committed transcript references stable with a large committed transcript", () => {
    const committed = Array.from({ length: 1_000 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`user_${String(index)}`, `prompt ${String(index)}`)
        : assistantMessage(
            `assistant_${String(index)}`,
            `reply ${String(index)}`,
            { status: "completed" },
          ),
    );
    const state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages: [
          ...committed,
          assistantMessage("assistant_live", "stream", {
            status: "streaming",
          }),
        ],
        status: { kind: "running", runId: "run_1" },
      }),
    );
    const committedRef = state.committedItems;

    const next = applyTuiEvent(state, {
      delta: "ing",
      messageId: "assistant_live",
      sessionId: "session_1",
      timestamp: 1,
      type: "message.part.delta",
    });

    expect(next.committedItems).toBe(committedRef);
    expect(next.liveMessage?.parts[0]).toMatchObject({
      text: "streaming",
    });
  });

  it("moves a completed live tail into committed transcript only after runtime idles", () => {
    const user = userMessage("user_1", "inspect this");
    const streaming = assistantMessage("assistant_1", "working", {
      status: "streaming",
    });
    let state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages: [user, streaming],
        status: { kind: "running", runId: "run_1" },
      }),
    );

    state = applyTuiEvent(state, {
      message: assistantMessage("assistant_1", "done", {
        status: "completed",
      }),
      sessionId: "session_1",
      type: "message.updated",
    });

    expect(state.committedItems.map((item) => item.messageId)).toEqual([
      "user_1",
    ]);
    expect(state.liveMessage?.id).toBe("assistant_1");

    state = applyTuiEvent(state, {
      status: { kind: "idle" },
      timestamp: 2,
      type: "runtime.updated",
    });

    expect(state.committedItems.map((item) => item.messageId)).toEqual([
      "user_1",
      "assistant_1",
    ]);
    expect(state.liveMessage).toBeNull();
  });

  it("resets committed and live transcript slices when the active session changes", () => {
    const state = createStateFromSnapshot(
      snapshotWithTranscript({
        messages: [
          userMessage("user_alpha", "alpha prompt"),
          assistantMessage("assistant_alpha", "alpha live", {
            status: "streaming",
          }),
        ],
        status: { kind: "running", runId: "run_alpha" },
      }),
    );

    const next = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_beta",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:03.000Z",
            id: "session_beta",
            messages: [userMessage("user_beta", "beta prompt")],
            title: "Beta",
            updatedAt: "2026-05-14T00:00:04.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });

    expect(next.activeSessionId).toBe("session_beta");
    expect(next.committedItems.map((item) => item.messageId)).toEqual([
      "user_beta",
    ]);
    expect(next.liveMessage).toBeNull();
    expect(next.messages.map((message) => message.id)).toEqual(["user_beta"]);
  });

  it("shows the target session cached transcript when switching to a known session", () => {
    const state = createStateFromSnapshot({
      ...snapshot(),
      activeSessionId: "session_alpha",
      sessions: [
        {
          createdAt: "2026-05-14T00:00:00.000Z",
          id: "session_alpha",
          messages: [userMessage("user_alpha", "alpha prompt")],
          title: "Alpha",
          updatedAt: "2026-05-14T00:00:01.000Z",
        },
        {
          createdAt: "2026-05-14T00:00:02.000Z",
          id: "session_beta",
          messages: [userMessage("user_beta", "beta cached prompt")],
          title: "Beta",
          updatedAt: "2026-05-14T00:00:03.000Z",
        },
      ],
    });

    const next = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_beta",
        sessions: [],
      },
      type: "snapshot.replaced",
    });

    expect(next.messages.map((message) => message.id)).toEqual(["user_beta"]);
    expect(next.committedItems.map((item) => item.messageId)).toEqual([
      "user_beta",
    ]);
  });

  it("leaves the transcript empty when switching to an unknown session", () => {
    const state = createStateFromSnapshot(snapshot());

    const next = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_unknown",
        sessions: [],
      },
      type: "snapshot.replaced",
    });

    expect(next.messages).toEqual([]);
    expect(next.committedItems).toEqual([]);
    expect(next.liveMessage).toBeNull();
  });

  it("keeps context window usage scoped to the active session", () => {
    const sessionOneUsage = contextWindowUsage("session_1", 38_400);
    const sessionTwoUsage = contextWindowUsage("session_2", 12_000);
    let state = createStateFromSnapshot({
      ...snapshot(),
      contextWindowUsages: [sessionOneUsage, sessionTwoUsage],
    });

    expect(state.contextWindowUsages).toEqual([
      sessionOneUsage,
      sessionTwoUsage,
    ]);
    expect(selectActiveContextWindowUsage(state)).toEqual(sessionOneUsage);

    state = applyTuiEvent(state, {
      usage: contextWindowUsage("session_2", 20_000),
      type: "context.window.updated",
    });

    expect(selectActiveContextWindowUsage(state)).toEqual(sessionOneUsage);

    const refreshedSessionOneUsage = contextWindowUsage("session_1", 40_000);
    state = applyTuiEvent(state, {
      usage: refreshedSessionOneUsage,
      type: "context.window.updated",
    });

    expect(selectActiveContextWindowUsage(state)).toEqual(
      refreshedSessionOneUsage,
    );
    expect(state.contextWindowUsages).toHaveLength(2);
  });

  it("tracks goal updates without rendering them yet", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      goal: {
        objective: "finish sdk contract",
        status: "active",
      },
      sessionId: "session_1",
      type: "goal.updated",
    });

    expect(state.goals).toEqual([
      expect.objectContaining({
        goal: expect.objectContaining({
          objective: "finish sdk contract",
          status: "active",
        }),
        sessionId: "session_1",
      }),
    ]);
    expect(state.snapshot.goals).toEqual(state.goals);

    state = applyTuiEvent(state, {
      goal: null,
      sessionId: "session_1",
      type: "goal.updated",
    });

    expect(state.goals).toEqual([]);
    expect(state.snapshot.goals).toBeUndefined();
  });

  it("does not show another session's cached context window usage after session switch", () => {
    const sessionOneUsage = contextWindowUsage("session_1", 38_400);
    let state = createStateFromSnapshot({
      ...snapshot(),
      contextWindowUsages: [sessionOneUsage],
    });

    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_2",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:03.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:03.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });

    expect(state.contextWindowUsages).toEqual([sessionOneUsage]);
    expect(selectActiveContextWindowUsage(state)).toBeNull();

    const sessionTwoUsage = contextWindowUsage("session_2", 12_000);
    state = applyTuiEvent(state, {
      usage: sessionTwoUsage,
      type: "context.window.updated",
    });

    expect(selectActiveContextWindowUsage(state)).toEqual(sessionTwoUsage);
  });

  it("applies message deltas to an existing assistant message part", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      delta: " world",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello world" });
  });

  it("applies generic message deltas to the last text part", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      delta: " world",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello world" });
  });

  it("uses delta content as the authoritative text snapshot when available", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      content: "Hello world",
      delta: " world",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello world" });
  });

  it("appends direct text deltas after a tool result instead of replacing earlier text", () => {
    const initial = {
      ...snapshot(),
      sessions: [
        {
          ...snapshot().sessions[0],
          messages: [
            {
              ...snapshot().sessions[0].messages[0],
              parts: [
                { text: "Before tool", type: "text" },
                {
                  call: {
                    id: "call_1",
                    input: {},
                    name: "read",
                    status: "completed",
                  },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_1",
                    output: "file contents",
                  },
                  type: "tool-result",
                },
              ],
            },
          ],
        },
      ],
    } as UiSnapshot;

    const state = applyTuiEvent(createStateFromSnapshot(initial), {
      content: "After tool",
      delta: "After tool",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts).toEqual([
      { text: "Before tool", type: "text" },
      expect.objectContaining({ type: "tool-call" }),
      expect.objectContaining({ type: "tool-result" }),
      { text: "After tool", type: "text" },
    ]);
  });

  it("uses delta content as authoritative text even when a part id resolves", () => {
    const initial = {
      ...snapshot(),
      sessions: [
        {
          ...snapshot().sessions[0],
          messages: [
            {
              ...snapshot().sessions[0].messages[0],
              parts: [{ id: "part_1", text: "Hello", type: "text" }],
            },
          ],
        },
      ],
    } as unknown as UiSnapshot;
    const state = applyTuiEvent(createStateFromSnapshot(initial), {
      content: "Hello world",
      delta: "Hello world",
      messageId: "message_1",
      partId: "part_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello world" });
  });

  it("ignores message deltas that do not identify a message", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      delta: " world",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
  });

  it("drops current-session deltas for missing messages and emits a warning notice", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      delta: " lost",
      messageId: "message_missing",
      sessionId: "session_1",
      timestamp: 1,
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
    expect(state.notices.at(-1)).toMatchObject({
      key: "message-delta:session_1:message_missing",
      level: "warning",
      source: "transcript",
      title: "Message unavailable",
    });
  });

  it("keeps a fresh view inactive when other sessions update", () => {
    const state = applyTuiEvent(
      createStateFromSnapshot({
        activeSessionId: null,
        permissions: [],
        runs: [],
        sessions: [],
        status: { kind: "idle" },
      }),
      {
        session: {
          createdAt: "2026-05-14T00:00:00.000Z",
          id: "session_new",
          messages: [],
          title: "New",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
        type: "session.updated",
      },
    );

    expect(state.activeSessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.sessions).toHaveLength(1);
  });

  it("binds a fresh view when it receives a transcript event", () => {
    let state = createStateFromSnapshot({
      activeSessionId: null,
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    });

    state = applyTuiEvent(state, {
      session: {
        createdAt: "2026-05-14T00:00:00.000Z",
        id: "session_new",
        messages: [],
        title: "New",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
      type: "session.updated",
    });
    state = applyTuiEvent(state, {
      message: {
        createdAt: "2026-05-14T00:00:01.000Z",
        id: "message_new",
        parts: [{ text: "Started", type: "text" }],
        role: "assistant",
      },
      sessionId: "session_new",
      type: "message.appended",
    });

    expect(state.activeSessionId).toBe("session_new");
    expect(state.messages).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.messages[0]?.parts[0]).toMatchObject({
      text: "Started",
    });
  });

  it("tracks permission, interaction, and command event queues", () => {
    const interaction = {
      commandRunId: "command_1",
      interactionId: "interaction_1",
      kind: "select-one",
      options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      subject: "model",
    } as const;
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      request: {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Run bash",
        id: "permission_1",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });
    state = applyTuiEvent(state, {
      request: interaction,
      timestamp: 1,
      type: "interaction.requested",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "Model changed" },
      timestamp: 1,
      type: "command.result.delivered",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_2",
      commandRunId: "command_2",
      error: { code: "BAD", message: "Unknown command" },
      timestamp: 2,
      type: "command.failed",
    });

    expect(state.permissions).toHaveLength(1);
    expect(state.interactions).toHaveLength(1);
    expect(state.commandNotices.map((notice) => notice.kind)).toEqual([
      "result",
      "error",
    ]);

    state = applyTuiEvent(state, {
      requestId: "permission_1",
      type: "permission.resolved",
    });
    state = applyTuiEvent(state, {
      commandRunId: "command_1",
      interactionId: "interaction_1",
      status: "accepted",
      timestamp: 3,
      type: "interaction.resolved",
    });

    expect(state.permissions).toHaveLength(0);
    expect(state.interactions).toHaveLength(0);
  });

  it("clears command notices when the active session appends a user message", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "next prompt"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("clears command error notices when the active session appends a user message", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      error: {
        code: "USER_CANCELLED",
        message: "Session selection cancelled",
      },
      timestamp: 1,
      type: "command.failed",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "next prompt"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("clears command notices when the active session run starts", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "running", runId: "run_1" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      type: "run.updated",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("clears command notices when runtime enters running directly", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      status: { kind: "running", runId: "run_1" },
      timestamp: 2,
      type: "runtime.updated",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("shows active run interruption as a lightweight command notice", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      runId: "run_1",
      sessionId: "session_1",
      timestamp: 1,
      type: "run.interrupted",
    });

    expect(state.commandNotices).toMatchObject([
      {
        commandId: "run.interrupted",
        kind: "result",
        sessionId: "session_1",
        text: "Interrupted",
      },
    ]);
  });

  it("ignores run interruption notices from inactive sessions", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      runId: "run_2",
      sessionId: "session_2",
      timestamp: 1,
      type: "run.interrupted",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("shows compact runtime while a compact command is running and clears it on result", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      command: {
        clientInvocationId: "invoke_compact",
        commandId: "compact",
        commandRunId: "command_compact",
        path: ["compact"],
        sessionId: "session_1",
        surface: "tui",
      },
      timestamp: 1,
      type: "command.started",
    });

    expect(state.runtime).toEqual({
      kind: "running",
      runId: "command_compact",
      title: "Compacting...",
    });
    expect(state.committedItems.map((item) => item.messageId)).toEqual([
      "message_1",
    ]);
    expect(state.liveMessage).toBeNull();

    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_compact",
      commandRunId: "command_compact",
      output: {
        data: {
          result: {
            status: "compacted",
          },
        },
        kind: "data",
        subject: "session.compact",
      },
      timestamp: 2,
      type: "command.result.delivered",
    });

    expect(state.runtime).toEqual({ kind: "idle" });
  });

  it("clears ephemeral UI notices when compact command starts while keeping prompt security notices", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_security",
        key: "prompt-security:OHBABY.md:ignore_previous_instructions",
        level: "warning",
        message: "OHBABY.md was skipped.",
        title: "Custom instructions skipped",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:01.000Z",
        id: "notice_provider",
        key: "provider:warning",
        level: "warning",
        message: "Provider warning.",
        title: "Provider warning",
      },
      timestamp: 2,
      type: "notice.emitted",
    });

    state = applyTuiEvent(state, {
      command: {
        clientInvocationId: "invoke_compact",
        commandId: "compact",
        commandRunId: "command_compact",
        path: ["compact"],
        sessionId: "session_1",
        surface: "tui",
      },
      timestamp: 3,
      type: "command.started",
    });

    expect(state.runtime).toEqual({
      kind: "running",
      runId: "command_compact",
      title: "Compacting...",
    });
    expect(state.notices.map((notice) => notice.id)).toEqual([
      "notice_security",
    ]);
  });

  it("shows compact runtime while a compact command is running and clears it on failure", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      command: {
        clientInvocationId: "invoke_compact",
        commandId: "compact",
        commandRunId: "command_compact",
        path: ["compact"],
        sessionId: "session_1",
        surface: "tui",
      },
      timestamp: 1,
      type: "command.started",
    });

    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_compact",
      commandRunId: "command_compact",
      error: {
        code: "COMPACT_FAILED",
        message: "Compact failed",
      },
      timestamp: 2,
      type: "command.failed",
    });

    expect(state.runtime).toEqual({ kind: "idle" });
  });

  it("does not clear command notices when the active session appends an assistant message", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      message: assistantMessage("assistant_2", "reply"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(1);
  });

  it("does not clear command notices for a non-active session message append", () => {
    let state = createStateFromSnapshot({
      ...snapshot(),
      sessions: [
        ...snapshot().sessions,
        {
          createdAt: "2026-05-14T00:00:04.000Z",
          id: "session_2",
          messages: [],
          title: "Second",
          updatedAt: "2026-05-14T00:00:04.000Z",
        },
      ],
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "other prompt"),
      sessionId: "session_2",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(1);
  });

  it("does not clear command notices when a non-active session run starts", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      run: {
        id: "run_2",
        sessionId: "session_2",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "running", runId: "run_2" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      type: "run.updated",
    });

    expect(state.commandNotices).toHaveLength(1);
  });

  it("drops late command notices that belong to another session", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      command: {
        clientInvocationId: "invoke_1",
        commandId: "status",
        commandRunId: "command_1",
        path: ["status"],
        sessionId: "session_1",
        surface: "tui",
      },
      timestamp: 1,
      type: "command.started",
    });
    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_2",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:04.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:04.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "stale status" },
      timestamp: 2,
      type: "command.result.delivered",
    });

    expect(state.commandNotices).toHaveLength(0);
  });

  it("keeps command notices for global commands without a session owner", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      command: {
        clientInvocationId: "invoke_1",
        commandId: "help",
        commandRunId: "command_1",
        path: ["help"],
        surface: "tui",
      },
      timestamp: 1,
      type: "command.started",
    });
    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_2",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:04.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:04.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "global help" },
      timestamp: 2,
      type: "command.result.delivered",
    });

    expect(state.commandNotices.map((notice) => notice.text)).toEqual([
      "global help",
    ]);
  });

  it("does not roll back live permission state from a replacement snapshot", () => {
    let state = createStateFromSnapshot({
      ...snapshot(),
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
    });
    state = applyTuiEvent(state, {
      permission: {
        level: "full-access",
        mode: "plan",
        sessionRules: [],
      },
      type: "permission.updated",
    });

    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        permission: {
          level: "default",
          mode: "auto",
          sessionRules: [],
        },
      },
      type: "snapshot.replaced",
    });

    expect(state.permission).toEqual({
      level: "full-access",
      mode: "plan",
      sessionRules: [],
    });
    expect(state.snapshot.permission).toEqual(state.permission);

    state = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(state.permission).toEqual({
      level: "full-access",
      mode: "plan",
      sessionRules: [],
    });
    expect(state.snapshot.permission).toEqual(state.permission);
  });

  it("keeps the active run visible after a permission is resolved", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "running", runId: "run_1" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      type: "run.updated",
    });
    state = applyTuiEvent(state, {
      request: {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Run bash",
        id: "permission_1",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });

    state = applyTuiEvent(state, {
      requestId: "permission_1",
      type: "permission.resolved",
    });

    expect(state.permissions).toHaveLength(0);
    expect(state.runtime).toEqual({ kind: "running", runId: "run_1" });
  });

  it("keeps the active run visible when the stored run still says waiting for permission", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "waiting-for-permission", requestId: "permission_1" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      type: "run.updated",
    });
    state = applyTuiEvent(state, {
      request: {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Run bash",
        id: "permission_1",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });

    state = applyTuiEvent(state, {
      requestId: "permission_1",
      type: "permission.resolved",
    });

    expect(state.permissions).toHaveLength(0);
    expect(state.runtime).toEqual({ kind: "running", runId: "run_1" });
  });

  it("keeps successful state-changing command results silent", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyCommandOutput(
      state,
      {
        data: {
          permission: {
            level: "default",
            mode: "plan",
            sessionRules: [],
          },
        },
        kind: "data",
        subject: "permission.mode",
      },
      "mode",
    );

    expect(state.commandNotices).toHaveLength(0);

    state = applyCommandOutput(
      state,
      {
        data: {
          permission: {
            level: "full-access",
            mode: "auto",
            sessionRules: [],
          },
        },
        kind: "data",
        subject: "permission.level",
      },
      "permission",
    );

    expect(state.commandNotices).toHaveLength(0);

    state = applyCommandOutput(
      state,
      {
        data: {
          session: {
            id: "session_2",
            title: "New session",
          },
        },
        kind: "data",
        subject: "session.created",
      },
      "new",
    );

    expect(state.commandNotices).toHaveLength(0);

    state = applyCommandOutput(
      state,
      {
        data: {
          sessionId: "session_2",
        },
        kind: "data",
        subject: "session.current",
      },
      "resume",
    );

    expect(state.commandNotices).toHaveLength(0);
  });

  it("formats compact command notices for humans without token deltas", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyCommandOutput(
      state,
      {
        data: {
          result: {
            status: "compacted",
            usageAfter: {
              currentTokens: 24,
            },
            usageBefore: {
              currentTokens: 92,
            },
          },
        },
        kind: "data",
        subject: "session.compact",
      },
      "compact",
    );

    expect(latestCommandNoticeText(state)).toBe("Compacted");

    state = applyCommandOutput(
      state,
      {
        data: {
          result: {
            status: "inflated",
          },
        },
        kind: "data",
        subject: "session.compact",
      },
      "compact",
    );
    expect(latestCommandNoticeText(state)).toBe("Compact skipped");

    state = applyCommandOutput(
      state,
      {
        data: {
          result: {
            status: "failed",
          },
        },
        kind: "data",
        subject: "session.compact",
      },
      "compact",
    );
    expect(latestCommandNoticeText(state)).toBe("Compact failed");
  });

  it("formats status command notices with optional backend summaries", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyCommandOutput(
      state,
      {
        data: {
          model: {
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            provider: "openai",
          },
          status: "idle",
        },
        kind: "data",
        subject: "status",
      },
      "status",
    );

    expect(latestCommandNoticeText(state)).toContain("╭─ Status");
    expect(latestCommandNoticeText(state)).toContain("│ Runtime  idle");
    expect(latestCommandNoticeText(state)).toContain("│ Model    GPT-5.5");
    expect(latestCommandNoticeText(state)).toContain(
      "│ Context  Context unavailable",
    );

    state = applyCommandOutput(
      state,
      {
        data: {
          context: {
            contextLimit: 128000,
            currentTokens: 9000,
          },
          contextWindow: {
            contextWindowRatio: 0.0384,
            contextWindowTokens: 1_000_000,
            currentTokens: 38_400,
            estimatedAt: "2026-06-06T00:00:00.000Z",
            modelId: "fake-model",
            sessionId: "session_1",
          },
          mcps: {
            connected: 1,
            disabled: 1,
            disconnected: 1,
            failed: 1,
            total: 4,
          },
          model: {
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            provider: "openai",
          },
          projectRoot: "D:/Projects/app",
          sessionId: "session_1",
          skillsCount: 2,
          status: "idle",
          tools: {
            builtin: 1,
            mcp: 1,
            module: 1,
            skill: 1,
          },
        },
        kind: "data",
        subject: "status",
      },
      "status_full",
    );

    expect(latestCommandNoticeText(state)).toContain("╭─ Status");
    expect(latestCommandNoticeText(state)).toContain("│ Runtime  idle");
    expect(latestCommandNoticeText(state)).toContain("│ Model    GPT-5.5");
    expect(latestCommandNoticeText(state)).toContain(
      "│ Context  38.4K / 1M (4%)",
    );
    expect(latestCommandNoticeText(state)).not.toContain(
      "9,000/128,000 tokens",
    );
  });

  it("formats model and help command notices", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyCommandOutput(
      state,
      {
        data: {
          current: {
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            provider: "openai",
          },
          models: [
            {
              id: "openai:gpt-5.5",
              label: "GPT-5.5",
              provider: "openai",
            },
          ],
        },
        kind: "data",
        subject: "models.current",
      },
      "models",
    );

    expect(latestCommandNoticeText(state)).toBe("model: GPT-5.5");

    state = applyCommandOutput(
      state,
      {
        data: {
          commands: [
            { description: "Show status", path: ["status"] },
            { description: "List MCP server status", path: ["mcps"] },
          ],
        },
        kind: "data",
        subject: "help",
      },
      "help",
    );

    expect(latestCommandNoticeText(state)).toBe(
      "/status - Show status\n/mcps - List MCP server status",
    );
  });

  it("formats MCP server and skill command notices without leaking MCP details", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyCommandOutput(
      state,
      {
        data: {
          servers: [
            { name: "github", status: "connected", toolCount: 8 },
            { error: "boom", name: "bad", status: "failed" },
            { name: "memory", status: "disabled" },
          ],
        },
        kind: "data",
        subject: "mcps",
      },
      "mcps",
    );

    expect(latestCommandNoticeText(state)).toBe(
      "mcps: github connected, bad failed, memory disabled",
    );

    state = applyCommandOutput(
      state,
      {
        data: {
          skills: [
            {
              description: "Review code",
              name: "review",
              scope: "project",
              source: "project-native",
            },
            {
              description: "Brainstorm ideas",
              name: "brainstorming",
              scope: "user",
            },
          ],
        },
        kind: "data",
        subject: "skills",
      },
      "skills",
    );

    expect(latestCommandNoticeText(state)).toBe(
      "skills: review [project, project-native] - Review code, brainstorming [user] - Brainstorm ideas",
    );
  });

  it("truncates large command outputs", () => {
    const longText = "x".repeat(400);
    const state = applyCommandOutput(
      createStateFromSnapshot(snapshot()),
      { kind: "text", text: longText },
      "long",
    );

    expect(latestCommandNoticeText(state)?.length).toBeLessThan(
      longText.length,
    );
    expect(latestCommandNoticeText(state)?.endsWith("...")).toBe(true);
  });

  it("deduplicates UI notices by key and keeps the most recent ten", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_1",
        key: "prompt-security:OHBABY.md:ignore_previous_instructions",
        level: "warning",
        message: "OHBABY.md was skipped.",
        source: "OHBABY.md",
        title: "Custom instructions skipped",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:01.000Z",
        id: "notice_2",
        key: "prompt-security:OHBABY.md:ignore_previous_instructions",
        level: "warning",
        message: "Duplicate warning.",
        source: "OHBABY.md",
        title: "Custom instructions skipped",
      },
      timestamp: 2,
      type: "notice.emitted",
    });
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]?.message).toBe("Duplicate warning.");

    for (let index = 0; index < 12; index += 1) {
      state = applyTuiEvent(state, {
        notice: {
          createdAt: "2026-05-19T00:00:02.000Z",
          id: `notice_extra_${String(index)}`,
          key: `provider:${String(index)}`,
          level: "error",
          message: `Provider error ${String(index)}`,
          title: "Provider error",
        },
        timestamp: 3 + index,
        type: "notice.emitted",
      });
    }

    expect(state.notices).toHaveLength(10);
    expect(
      state.notices.some(
        (notice) =>
          notice.key ===
          "prompt-security:OHBABY.md:ignore_previous_instructions",
      ),
    ).toBe(false);
    expect(new Set(state.notices.map((notice) => notice.id)).size).toBe(10);
    expect(state.notices.at(-1)?.message).toBe("Provider error 11");
  });

  it("clears ephemeral UI notices on the next active user message while keeping prompt security notices", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_security",
        key: "prompt-security:OHBABY.md:ignore_previous_instructions",
        level: "warning",
        message: "OHBABY.md was skipped.",
        title: "Custom instructions skipped",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:01.000Z",
        id: "notice_provider",
        key: "provider:warning",
        level: "warning",
        message: "Provider warning.",
        title: "Provider warning",
      },
      timestamp: 2,
      type: "notice.emitted",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "next prompt"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.notices.map((notice) => notice.id)).toEqual([
      "notice_security",
    ]);
  });

  it("clears ephemeral UI notices when runtime enters running while keeping prompt security notices", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_security",
        key: "prompt-security:OHBABY.md:ignore_previous_instructions",
        level: "warning",
        message: "OHBABY.md was skipped.",
        title: "Custom instructions skipped",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:01.000Z",
        id: "notice_provider",
        key: "provider:warning",
        level: "warning",
        message: "Provider warning.",
        title: "Provider warning",
      },
      timestamp: 2,
      type: "notice.emitted",
    });

    state = applyTuiEvent(state, {
      status: { kind: "running", runId: "run_1" },
      timestamp: 3,
      type: "runtime.updated",
    });

    expect(state.notices.map((notice) => notice.id)).toEqual([
      "notice_security",
    ]);
  });

  it("applies permission updates and preserves them across collection rebuilds", () => {
    let state = createStateFromSnapshot({
      ...snapshot(),
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
    });

    state = applyTuiEvent(state, {
      permission: {
        level: "full-access",
        mode: "plan",
        sessionRules: [],
      },
      previousPermission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
      timestamp: 1,
      type: "permission.updated",
    });
    state = applyTuiEvent(state, {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "running", runId: "run_1" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      timestamp: 2,
      type: "run.updated",
    });

    expect(state.permission).toEqual({
      level: "full-access",
      mode: "plan",
      sessionRules: [],
    });
    expect(state.snapshot.permission).toEqual(state.permission);
  });

  it("marks catalog invalidation without mutating the loaded catalog", () => {
    const state = setCommandCatalog(
      createStateFromSnapshot(snapshot()),
      catalog(),
    );

    const next = applyTuiEvent(state, {
      reason: "plugin changed",
      timestamp: 1,
      type: "command.catalog.updated",
      version: "v2",
    });

    expect(next.catalog?.version).toBe("v1");
    expect(next.catalogInvalidation).toMatchObject({
      reason: "plugin changed",
      version: "v2",
    });
  });

  it("preserves local interactions and command notices when replacing the snapshot", () => {
    const interaction = {
      commandRunId: "command_1",
      interactionId: "interaction_1",
      kind: "confirm",
      subject: "command",
    } as const;
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      request: interaction,
      timestamp: 1,
      type: "interaction.requested",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "ok" },
      timestamp: 2,
      type: "command.result.delivered",
    });

    const next = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(next.interactions).toHaveLength(1);
    expect(next.commandNotices).toHaveLength(1);
  });

  it("keeps newer local messages when an old snapshot arrives", () => {
    const appendedMessage = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "message_local",
      parts: [{ text: "new local message", type: "text" }],
      role: "assistant",
    } as const;
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      message: appendedMessage,
      sessionId: "session_1",
      type: "message.appended",
    });

    state = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(state.messages.map((message) => message.id)).toContain(
      "message_local",
    );
    expect(
      state.sessions
        .find((session) => session.id === "session_1")
        ?.messages.map((message) => message.id),
    ).toContain("message_local");
  });

  it("lets snapshot messages replace stale local messages with the same id", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      message: {
        createdAt: "2026-05-14T00:00:01.000Z",
        id: "message_1",
        parts: [{ text: "local stale text", type: "text" }],
        role: "assistant",
      },
      sessionId: "session_1",
      type: "message.updated",
    });

    state = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
  });

  it("clears command notices when a snapshot switches sessions", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "ok" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_2",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:04.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:04.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });

    expect(state.activeSessionId).toBe("session_2");
    expect(state.commandNotices).toHaveLength(0);
  });

  it("preserves local UI notices when replacing the snapshot", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_1",
        key: "runtime:missing-key",
        level: "error",
        message: "OPENAI_API_KEY is not configured",
        title: "Runtime error",
      },
      timestamp: 1,
      type: "notice.emitted",
    });

    state = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(state.notices).toEqual([
      expect.objectContaining({
        key: "runtime:missing-key",
        message: "OPENAI_API_KEY is not configured",
      }),
    ]);
  });

  it("filters session-scoped UI notices when a snapshot switches sessions", () => {
    let state = createStateFromSnapshot(snapshot());
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_context",
        key: "context-window:session_1",
        level: "warning",
        message: "Context window usage could not be refreshed",
        source: "context",
        title: "Context unavailable",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    state = applyTuiEvent(state, {
      notice: {
        createdAt: "2026-05-19T00:00:01.000Z",
        id: "notice_global",
        key: "runtime:missing-key",
        level: "error",
        message: "OPENAI_API_KEY is not configured",
        title: "Runtime error",
      },
      timestamp: 2,
      type: "notice.emitted",
    });

    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        activeSessionId: "session_2",
        sessions: [
          ...snapshot().sessions,
          {
            createdAt: "2026-05-14T00:00:04.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:04.000Z",
          },
        ],
      },
      type: "snapshot.replaced",
    });

    expect(state.notices.map((notice) => notice.id)).toEqual(["notice_global"]);
  });

  it("drops session-scoped UI notices for inactive sessions", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_context",
        key: "context-window:session_2",
        level: "warning",
        message: "Context window usage could not be refreshed",
        source: "context",
        title: "Context unavailable",
      },
      timestamp: 1,
      type: "notice.emitted",
    });

    expect(state.notices).toHaveLength(0);
  });

  it("keeps live permissions across an old snapshot and does not revive resolved permissions", () => {
    const request = {
      choices: [{ id: "allow", intent: "allow", label: "Allow" }],
      description: "Run bash",
      id: "permission_1",
      runId: "run_1",
      title: "Permission",
    } as const;
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      request,
      type: "permission.requested",
    });

    state = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });
    expect(state.permissions.map((permission) => permission.id)).toEqual([
      "permission_1",
    ]);

    state = applyTuiEvent(state, {
      requestId: "permission_1",
      type: "permission.resolved",
    });
    state = applyTuiEvent(state, {
      snapshot: {
        ...snapshot(),
        permissions: [request],
      },
      type: "snapshot.replaced",
    });

    expect(state.permissions).toHaveLength(0);
  });

  it("keeps command notice ids unique after truncation", () => {
    let state = createStateFromSnapshot(snapshot());

    for (let index = 0; index < 25; index += 1) {
      state = applyTuiEvent(state, {
        clientInvocationId: `invoke_${String(index)}`,
        commandRunId: `command_${String(index)}`,
        output: { kind: "text", text: `ok ${String(index)}` },
        timestamp: index,
        type: "command.result.delivered",
      });
    }

    expect(state.commandNotices).toHaveLength(20);
    expect(new Set(state.commandNotices.map((notice) => notice.id)).size).toBe(
      20,
    );
  });

  it("notifies subscribers when dispatching through the external store", () => {
    const store = createTuiStore(snapshot());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.dispatch({
      status: { kind: "running", runId: "run_1" },
      timestamp: 1,
      type: "runtime.updated",
    });
    unsubscribe();
    store.dispatch({
      status: { kind: "idle" },
      timestamp: 2,
      type: "runtime.updated",
    });

    expect(calls).toBe(1);
    expect(store.getState().runtime).toEqual({
      kind: "idle",
    });
  });
});
