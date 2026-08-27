import { describe, expect, it } from "vitest";
import type { UiMessage, UiSnapshot } from "ohbaby-sdk";
import type { StoreSnapshot } from "../api/daemon/wire.js";
import { messageText, selectViewModel } from "./selectors.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function store(
  snapshot: UiSnapshot,
  currentModel: StoreSnapshot["currentModel"] = null,
): StoreSnapshot {
  return {
    connectionState: "live",
    currentModel,
    error: null,
    view: {
      commandCatalogVersion: null,
      commandNotices: [],
      lastAppliedSeqNum: 10,
      reasoningByMessageId: {},
      snapshot,
    },
  };
}

function baseSnapshot(): UiSnapshot {
  return {
    activeSessionId: "session_1",
    contextWindowUsages: [
      {
        composition: {
          "system-prompt": 8_000,
          "builtin-tools": 4_000,
          mcp: 2_000,
          skills: 1_000,
          conversation: 30_000,
          "summarized-conversation": 4_000,
          "subagent-exchanges": 1_000,
        },
        contextWindowRatio: 0.25,
        contextWindowTokens: 200_000,
        currentTokens: 50_000,
        estimatedAt: timestamp,
        modelId: "glm-5.1",
        sessionId: "session_1",
      },
    ],
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

describe("ohbaby-web ui selectors", () => {
  it("selects only queued prompts for the active session", () => {
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
    const view = selectViewModel(
      store({
        ...baseSnapshot(),
        prompts: [
          prompt,
          { ...prompt, promptId: "prompt_2", sessionId: "session_2" },
          { ...prompt, promptId: "prompt_3", status: "starting" },
        ],
      }),
    );

    expect(view.queuedPrompts.map((item) => item.promptId)).toEqual([
      "prompt_1",
    ]);
  });

  it("projects header and composer state from the daemon snapshot", () => {
    const view = selectViewModel(store(baseSnapshot()));

    expect(view.header).toMatchObject({
      connectionKind: "idle",
      contextLabel: "50k / 200k",
      contextRatio: 0.25,
      modelLabel: "glm-5.1",
      statusLabel: "idle",
    });
    expect(view.header.contextWindowUsage).toMatchObject({
      composition: { conversation: 30_000 },
      sessionId: "session_1",
    });
    expect(view.composer).toMatchObject({
      canSend: true,
      mode: "auto",
      permissionLevel: "default",
    });
  });

  it("projects a running status title into the header label", () => {
    const view = selectViewModel(
      store({
        ...baseSnapshot(),
        status: {
          kind: "running",
          runId: "run_1",
          title: "Compacting...",
        },
      }),
    );

    expect(view.header).toMatchObject({
      connectionKind: "running",
      statusLabel: "Compacting...",
    });
  });

  it("projects the persisted active run start time for elapsed UI", () => {
    const running = { kind: "running", runId: "run_1" } as const;
    const view = selectViewModel(
      store({
        ...baseSnapshot(),
        runs: [
          {
            id: "run_old",
            sessionId: "session_1",
            startedAt: "2026-06-11T00:00:00.000Z",
            status: { kind: "idle" },
            updatedAt: "2026-06-11T00:00:01.000Z",
          },
          {
            id: "run_1",
            sessionId: "session_1",
            startedAt: timestamp,
            status: running,
            updatedAt: timestamp,
          },
        ],
        status: running,
      }),
    );

    expect(view.composer.activeRunStartedAt).toBe(timestamp);
    expect(view.composer.activeRunId).toBe("run_1");
  });

  it("uses the connected model before a session has context usage", () => {
    const snapshot = { ...baseSnapshot(), contextWindowUsages: [] };
    const view = selectViewModel(
      store(snapshot, {
        baseUrl: "https://zenmux.ai/api/anthropic",
        interfaceProvider: "anthropic",
        model: "deepseek-v4-pro",
        provider: "zenmux",
      }),
    );

    expect(view.header).toMatchObject({
      contextLabel: "0 / 0",
      contextRatio: 0,
      contextWindowUsage: null,
      modelLabel: "deepseek-v4-pro",
    });
  });

  it("does not use another session's context usage for the active header", () => {
    const snapshot = baseSnapshot();
    const view = selectViewModel(
      store({
        ...snapshot,
        contextWindowUsages: [
          {
            ...snapshot.contextWindowUsages?.[0],
            contextWindowRatio: 0.9,
            contextWindowTokens: 200_000,
            currentTokens: 180_000,
            estimatedAt: timestamp,
            modelId: "child-model",
            sessionId: "session_child",
          },
        ],
      }),
    );

    expect(view.header).toMatchObject({
      contextLabel: "0 / 0",
      contextRatio: 0,
      contextWindowUsage: null,
      modelLabel: "model pending",
    });
  });

  it("does not treat listed sessions as active when the daemon has no active session", () => {
    const view = selectViewModel(
      store({
        ...baseSnapshot(),
        activeSessionId: null,
        contextWindowUsages: [
          {
            contextWindowRatio: 0.9,
            contextWindowTokens: 200_000,
            currentTokens: 180_000,
            estimatedAt: timestamp,
            modelId: "child-model",
            sessionId: "session_child",
          },
        ],
      }),
    );

    expect(view.activeSession).toBeNull();
    expect(view.composer.activeSessionId).toBeUndefined();
    expect(view.header.contextWindowUsage).toBeNull();
    expect(view.header.contextLabel).toBe("0 / 0");
    expect(view.header.modelLabel).toBe("model pending");
    expect(view.isEmpty).toBe(true);
  });

  it("keeps already pending permissions visible under full-access policy", () => {
    const snapshot = {
      ...baseSnapshot(),
      permission: { level: "full-access", mode: "plan", sessionRules: [] },
      permissions: [
        {
          choices: [{ id: "allow", intent: "allow", label: "Allow" }],
          description: "Run bash",
          id: "permission_1",
          runId: "run_1",
          title: "Permission",
        },
      ],
    } satisfies UiSnapshot;

    expect(selectViewModel(store(snapshot)).pendingPermissions).toHaveLength(1);
  });

  it("projects the active session goal into the view model", () => {
    const view = selectViewModel(
      store({
        ...baseSnapshot(),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              status: "paused",
            },
            sessionId: "session_1",
          },
          {
            goal: {
              objective: "other session goal",
              status: "active",
            },
            sessionId: "session_2",
          },
        ],
      }),
    );

    expect(view.activeGoal).toEqual({
      objective: "finish goal UI",
      status: "paused",
    });
  });

  it("returns no active goal when the snapshot has no goal for the session", () => {
    expect(selectViewModel(store(baseSnapshot())).activeGoal).toBeNull();

    const otherSessionOnly = selectViewModel(
      store({
        ...baseSnapshot(),
        goals: [
          {
            goal: {
              objective: "other session goal",
              status: "active",
            },
            sessionId: "session_2",
          },
        ],
      }),
    );
    expect(otherSessionOnly.activeGoal).toBeNull();
  });

  it("selects only a visible non-empty todo list for the active session", () => {
    const visible = selectViewModel(
      store({
        ...baseSnapshot(),
        todos: [
          {
            sessionId: "session_2",
            todos: [{ content: "Other", status: "pending" }],
            visible: true,
          },
          {
            sessionId: "session_1",
            todos: [{ content: "Active", status: "in_progress" }],
            visible: true,
          },
        ],
      }),
    );
    const hidden = selectViewModel(
      store({
        ...baseSnapshot(),
        todos: [
          {
            sessionId: "session_1",
            todos: [{ content: "Done", status: "completed" }],
            visible: false,
          },
        ],
      }),
    );

    expect(visible.activeTodoList?.todos).toEqual([
      { content: "Active", status: "in_progress" },
    ]);
    expect(hidden.activeTodoList).toBeNull();
  });

  it("extracts display text from text and reasoning message parts only", () => {
    const message: UiMessage = {
      createdAt: timestamp,
      id: "message_1",
      parts: [
        { text: "hello", type: "text" },
        { text: " there", type: "reasoning" },
        {
          call: { id: "call_1", input: {}, name: "read", status: "completed" },
          type: "tool-call",
        },
      ],
      role: "assistant",
    };

    expect(messageText(message)).toBe("hello there");
  });

  it("passes command notices through to the view model", () => {
    const snapshot = store(baseSnapshot());
    const view = selectViewModel({
      ...snapshot,
      view: {
        ...snapshot.view,
        commandNotices: [
          {
            commandId: "status",
            createdAt: timestamp,
            id: "command_1",
            kind: "success",
            path: ["status"],
            text: "status",
          },
        ],
      },
    });

    expect(view.commandNotices).toHaveLength(1);
    expect(view.commandNotices[0]).toMatchObject({
      commandId: "status",
      text: "status",
    });
  });
});
