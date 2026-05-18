import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import {
  applyTuiEvent,
  createStateFromSnapshot,
  createTuiStore,
  setCommandCatalog,
} from "./events.js";
import type {
  TuiCommandCatalog,
} from "./snapshot.js";

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

function catalog(version = "v1"): TuiCommandCatalog {
  return {
    commands: [
      {
        description: "Select or switch model",
        id: "model",
        path: ["model"],
        surfaces: ["tui"],
      },
    ],
    loadedAt: 1_771_000_000_000,
    surface: "tui",
    version,
  };
}

describe("TUI store event reducer", () => {
  it("projects the active session messages from the initial snapshot", () => {
    const state = createStateFromSnapshot(snapshot());

    expect(state.activeSessionId).toBe("session_1");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
    expect(state.runtime).toEqual({ kind: "idle" });
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

  it("projects the first backend session update when no session is active", () => {
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
    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Started" });
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

  it("marks catalog invalidation without mutating the loaded catalog", () => {
    const state = setCommandCatalog(createStateFromSnapshot(snapshot()), catalog());

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
