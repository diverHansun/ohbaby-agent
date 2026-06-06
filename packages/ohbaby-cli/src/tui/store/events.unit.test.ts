import { describe, expect, it } from "vitest";
import type {
  UiCommandOutput,
  UiContextWindowUsage,
  UiSnapshot,
} from "ohbaby-sdk";
import {
  selectActiveContextWindowUsage,
} from "./selectors.js";
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

  it("formats permission and compact command notices for humans", () => {
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

    expect(latestCommandNoticeText(state)).toBe("mode: plan | level: default");

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

    expect(latestCommandNoticeText(state)).toBe(
      "level: full-access | mode: auto",
    );

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

    expect(latestCommandNoticeText(state)).toBe(
      "compact: compacted (92 -> 24 tokens)",
    );
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

    expect(latestCommandNoticeText(state)).toBe(
      "status: idle | model: GPT-5.5",
    );

    state = applyCommandOutput(
      state,
      {
        data: {
          context: {
            contextLimit: 128000,
            currentTokens: 9000,
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

    expect(latestCommandNoticeText(state)).toBe(
      "status: idle | model: GPT-5.5 | session: session_1 | tools: 1 builtin, 1 module, 1 skill, 1 mcp | skills: 2 | mcps: 1 connected, 1 failed, 1 disabled, 1 disconnected | context: 9,000/128,000 tokens | project: D:/Projects/app",
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
          categories: [
            {
              commands: [
                { description: "Show status", path: ["status"] },
                { description: "List MCP server status", path: ["mcps"] },
              ],
              name: "system",
              title: "System",
            },
          ],
          commands: [],
        },
        kind: "data",
        subject: "help",
      },
      "help",
    );

    expect(latestCommandNoticeText(state)).toBe(
      "System:\n  /status Show status\n  /mcps List MCP server status",
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
