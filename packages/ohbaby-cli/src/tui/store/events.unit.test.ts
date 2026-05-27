import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import {
  applyTuiEvent,
  createStateFromSnapshot,
  createTuiStore,
  setCommandCatalog,
} from "./events.js";
import type { TuiCommandCatalog } from "./snapshot.js";

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

  it("formats command notices for humans and truncates large outputs", () => {
    let state = createStateFromSnapshot(snapshot());

    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_mode",
      commandRunId: "command_mode",
      output: {
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
      timestamp: 1,
      type: "command.result.delivered",
    });

    expect(state.commandNotices.at(-1)?.text).toBe(
      "mode: plan | level: default",
    );

    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_permission",
      commandRunId: "command_permission",
      output: {
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
      timestamp: 2,
      type: "command.result.delivered",
    });

    expect(state.commandNotices.at(-1)?.text).toBe(
      "level: full-access | mode: auto",
    );

    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_compact",
      commandRunId: "command_compact",
      output: {
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
      timestamp: 3,
      type: "command.result.delivered",
    });

    expect(state.commandNotices.at(-1)?.text).toBe(
      "compact: compacted (92 -> 24 tokens)",
    );

    const longText = "x".repeat(400);
    state = applyTuiEvent(state, {
      clientInvocationId: "invoke_long",
      commandRunId: "command_long",
      output: { kind: "text", text: longText },
      timestamp: 4,
      type: "command.result.delivered",
    });

    expect(state.commandNotices.at(-1)?.text.length).toBeLessThan(
      longText.length,
    );
    expect(state.commandNotices.at(-1)?.text.endsWith("...")).toBe(true);
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
