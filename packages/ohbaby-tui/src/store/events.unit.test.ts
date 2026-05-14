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
  TuiInteractionRequest,
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
      partIndex: 0,
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello world" });
  });

  it("ignores message deltas that do not identify a part", () => {
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      delta: " world",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: "Hello" });
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
    const interaction: TuiInteractionRequest = {
      interactionId: "interaction_1",
      kind: "select-one",
      options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      subject: "model",
    };
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
      interaction,
      type: "interaction.requested",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_1",
      commandId: "model",
      output: "Model changed",
      type: "command.result.delivered",
    });
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_2",
      commandId: "bad",
      error: { message: "Unknown command" },
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
      interactionId: "interaction_1",
      type: "interaction.resolved",
    });

    expect(state.permissions).toHaveLength(0);
    expect(state.interactions).toHaveLength(0);
  });

  it("marks catalog invalidation without mutating the loaded catalog", () => {
    const state = setCommandCatalog(createStateFromSnapshot(snapshot()), catalog());

    const next = applyTuiEvent(state, {
      reason: "plugin changed",
      type: "command.catalog.updated",
      version: "v2",
    });

    expect(next.catalog?.version).toBe("v1");
    expect(next.catalogInvalidation).toMatchObject({
      reason: "plugin changed",
      version: "v2",
    });
  });

  it("clears pending interactions when replacing the snapshot", () => {
    const interaction: TuiInteractionRequest = {
      interactionId: "interaction_1",
      kind: "confirm",
      subject: "command",
    };
    const state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      interaction,
      type: "interaction.requested",
    });

    const next = applyTuiEvent(state, {
      snapshot: snapshot(),
      type: "snapshot.replaced",
    });

    expect(next.interactions).toHaveLength(0);
  });

  it("keeps command notice ids unique after truncation", () => {
    let state = createStateFromSnapshot(snapshot());

    for (let index = 0; index < 25; index += 1) {
      state = applyTuiEvent(state, {
        commandId: "model",
        output: `ok ${String(index)}`,
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
      runtime: { kind: "running", runId: "run_1" },
      type: "runtime.updated",
    });
    unsubscribe();
    store.dispatch({
      runtime: { kind: "idle" },
      type: "runtime.updated",
    });

    expect(calls).toBe(1);
    expect(store.getState().runtime).toEqual({
      kind: "idle",
    });
  });
});
