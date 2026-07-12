import { describe, expect, it } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiEvent,
  UiMessage,
  UiSnapshot,
} from "ohbaby-sdk";
import { DaemonClientViewCoordinator } from "./client-view.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function textMessage(id: string, text: string): UiMessage {
  return {
    createdAt: timestamp,
    id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
}

function sessionWithMessages(
  id: string,
  messages: readonly UiMessage[] = [],
  updatedAt = timestamp,
): UiSnapshot["sessions"][number] {
  return {
    createdAt: timestamp,
    id,
    messages,
    title: id,
    updatedAt,
  };
}

function emptySnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

function snapshotWithSessions(): UiSnapshot {
  return {
    ...emptySnapshot(),
    activeSessionId: "session_1",
    contextWindowUsages: [
      {
        contextWindowRatio: 0.1,
        contextWindowTokens: 100,
        currentTokens: 10,
        estimatedAt: timestamp,
        modelId: "model",
        sessionId: "session_1",
      },
      {
        contextWindowRatio: 0.2,
        contextWindowTokens: 100,
        currentTokens: 20,
        estimatedAt: timestamp,
        modelId: "model",
        sessionId: "session_2",
      },
    ],
    permissions: [
      {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Allow tool",
        id: "permission_1",
        runId: "run_1",
        title: "Tool permission",
      },
      {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Allow tool",
        id: "permission_2",
        runId: "run_2",
        title: "Tool permission",
      },
    ],
    prompts: [
      {
        createdAt: timestamp,
        promptId: "prompt_1",
        scopeKey: "/repo",
        sessionId: "session_1",
        status: "queued",
        text: "first",
        updatedAt: timestamp,
        userMessageId: "prompt_message_1",
      },
      {
        createdAt: timestamp,
        promptId: "prompt_2",
        scopeKey: "/repo",
        sessionId: "session_2",
        status: "queued",
        text: "second",
        updatedAt: timestamp,
        userMessageId: "prompt_message_2",
      },
    ],
    runs: [
      {
        id: "run_1",
        sessionId: "session_1",
        startedAt: timestamp,
        status: { kind: "running", runId: "run_1" },
        updatedAt: timestamp,
      },
      {
        id: "run_2",
        sessionId: "session_2",
        startedAt: timestamp,
        status: { kind: "running", runId: "run_2" },
        updatedAt: timestamp,
      },
    ],
    sessions: [
      sessionWithMessages("session_1", [
        textMessage("message_1", "current transcript"),
      ]),
      sessionWithMessages("session_2", [
        textMessage("message_2", "hidden transcript"),
      ]),
    ],
    status: { kind: "running", runId: "run_1" },
  };
}

function messageAppended(sessionId: string): UiEvent {
  return {
    message: textMessage(`message_${sessionId}`, `Message ${sessionId}`),
    sessionId,
    type: "message.appended",
  };
}

function commandResult(
  clientInvocationId = "invoke_1",
): Extract<UiEvent, { type: "command.result.delivered" }> {
  return {
    clientInvocationId,
    commandRunId: "command_1",
    output: { kind: "text", text: "done" },
    timestamp: Date.parse(timestamp),
    type: "command.result.delivered",
  };
}

function commandSessionSelected(
  sessionId: string,
  clientInvocationId = "invoke_1",
): Extract<UiEvent, { type: "command.result.delivered" }> {
  return {
    action: {
      data: { choiceId: sessionId },
      kind: "session.selected",
    },
    clientInvocationId,
    commandRunId: "command_1",
    timestamp: Date.parse(timestamp),
    type: "command.result.delivered",
  };
}

function runUpdated(runId: string, sessionId: string): UiEvent {
  return {
    run: {
      id: runId,
      sessionId,
      startedAt: timestamp,
      status: { kind: "running", runId },
      updatedAt: timestamp,
    },
    type: "run.updated",
  };
}

function runtimeRunning(runId: string): UiEvent {
  return {
    status: { kind: "running", runId },
    type: "runtime.updated",
  };
}

type ExecuteCommandInvocation = Parameters<
  UiBackendClient["executeCommand"]
>[0];

function commandInvocation(commandId = "status"): ExecuteCommandInvocation {
  return {
    argv: [],
    clientInvocationId: "invoke_1",
    commandId,
    path: [commandId],
    raw: `/${commandId}`,
    rawArgs: "",
    surface: "tui",
  };
}

describe("DaemonClientViewCoordinator", () => {
  it("only grants prompt access within the client's selected session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = snapshotWithSessions();
    coordinator.initializeClient("client_1", snapshot, {
      resumeSessionId: "session_1",
    });

    expect(coordinator.canAccessPrompt("client_1", snapshot, "prompt_1")).toBe(
      true,
    );
    expect(coordinator.canAccessPrompt("client_1", snapshot, "prompt_2")).toBe(
      false,
    );
  });

  it("does not project a run-scoped error into another selected session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const base = snapshotWithSessions();
    const snapshot: UiSnapshot = {
      ...base,
      runs: base.runs.map((run) =>
        run.sessionId === "session_1"
          ? {
              ...run,
              status: {
                kind: "error",
                message: "session 1 failed",
                recoverable: true,
              },
            }
          : run,
      ),
      status: {
        kind: "error",
        message: "session 1 failed",
        recoverable: true,
      },
    };
    coordinator.initializeClient("client_2", snapshot, {
      resumeSessionId: "session_2",
    });

    expect(coordinator.projectSnapshot("client_2", snapshot).status).toEqual({
      kind: "running",
      runId: "run_2",
    });
  });

  it("does not resurrect an older error after the same session later succeeds", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const base = snapshotWithSessions();
    const snapshot: UiSnapshot = {
      ...base,
      permissions: [],
      runs: [
        {
          id: "run_failed",
          sessionId: "session_1",
          startedAt: timestamp,
          status: {
            kind: "error",
            message: "old failure",
            recoverable: true,
          },
          updatedAt: "2026-06-12T00:00:01.000Z",
        },
        {
          id: "run_succeeded",
          sessionId: "session_1",
          startedAt: timestamp,
          status: { kind: "idle" },
          updatedAt: "2026-06-12T00:00:02.000Z",
        },
      ],
      status: { kind: "idle" },
    };
    coordinator.initializeClient("client_1", snapshot, {
      resumeSessionId: "session_1",
    });

    expect(coordinator.projectSnapshot("client_1", snapshot).status).toEqual({
      kind: "idle",
    });
  });

  it("projects snapshots to the initialized active session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = snapshotWithSessions();

    coordinator.initializeClient("client_a", snapshot, {
      resumeSessionId: "session_1",
      initialPermission: { level: "full-access", mode: "plan" },
    });

    expect(coordinator.projectSnapshot("client_a", snapshot)).toMatchObject({
      activeSessionId: "session_1",
      contextWindowUsages: [{ sessionId: "session_1" }],
      permission: { level: "full-access", mode: "plan" },
      permissions: [{ id: "permission_1" }],
      runs: [{ id: "run_1" }],
      status: { kind: "running", runId: "run_1" },
      sessions: [
        {
          id: "session_1",
          messages: [textMessage("message_1", "current transcript")],
        },
        { id: "session_2", messages: [] },
      ],
    });
  });

  it("continues with the most recently updated session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = {
      ...emptySnapshot(),
      sessions: [
        sessionWithMessages("session_older", [], "2026-06-12T00:00:00.000Z"),
        sessionWithMessages("session_newer", [], "2026-06-13T00:00:00.000Z"),
      ],
    };

    coordinator.initializeClient("client_a", snapshot, {
      startupSessionMode: { type: "continue" },
    });

    expect(
      coordinator.projectSnapshot("client_a", snapshot).activeSessionId,
    ).toBe("session_newer");
  });

  it("generates an explicit session for fresh prompt submissions", () => {
    const coordinator = new DaemonClientViewCoordinator();

    coordinator.initializeClient("client_a", emptySnapshot(), {
      startupSessionMode: { type: "fresh" },
    });
    const prepared = coordinator.preparePromptSubmit(
      "client_a",
      undefined,
      () => "session_generated",
    );

    expect(prepared).toEqual({
      options: { sessionId: "session_generated" },
      sessionId: "session_generated",
    });
    expect(
      coordinator.projectSnapshot("client_a", emptySnapshot()).activeSessionId,
    ).toBe("session_generated");
  });

  it("filters session scoped events outside a client view", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = {
      ...emptySnapshot(),
      sessions: [sessionWithMessages("session_1")],
    };

    coordinator.initializeClient("client_active", snapshot, {
      resumeSessionId: "session_1",
    });
    coordinator.initializeClient("client_fresh", snapshot, {
      startupSessionMode: { type: "fresh" },
    });

    expect(
      coordinator.routeEventForClient(
        messageAppended("session_1"),
        "client_active",
      ),
    ).toEqual(messageAppended("session_1"));
    expect(
      coordinator.routeEventForClient(
        messageAppended("session_1"),
        "client_fresh",
      ),
    ).toBeUndefined();
  });

  it("routes command events only to the invoking client", () => {
    const coordinator = new DaemonClientViewCoordinator();

    coordinator.prepareCommandInvocation("client_a", commandInvocation());

    expect(
      coordinator.routeEventForClient(commandResult(), "client_a"),
    ).toEqual(commandResult());
    expect(
      coordinator.routeEventForClient(commandResult(), "client_b"),
    ).toBeUndefined();
  });

  it("updates only the invoking client when a command selects a session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = {
      ...emptySnapshot(),
      sessions: [
        sessionWithMessages("session_1", [textMessage("m1", "one")]),
        sessionWithMessages("session_2", [textMessage("m2", "two")]),
      ],
    };

    coordinator.initializeClient("client_a", snapshot, {
      resumeSessionId: "session_1",
    });
    coordinator.initializeClient("client_b", snapshot, {
      resumeSessionId: "session_1",
    });
    coordinator.prepareCommandInvocation(
      "client_a",
      commandInvocation("sessions"),
    );
    coordinator.observeEvent(commandSessionSelected("session_2"));

    expect(
      coordinator.projectSnapshot("client_a", snapshot).activeSessionId,
    ).toBe("session_2");
    expect(
      coordinator.projectSnapshot("client_b", snapshot).activeSessionId,
    ).toBe("session_1");
  });

  it("routes runtime updates only to clients that own the run session", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = {
      ...emptySnapshot(),
      sessions: [sessionWithMessages("session_1")],
    };

    coordinator.initializeClient("client_active", snapshot, {
      resumeSessionId: "session_1",
    });
    coordinator.initializeClient("client_fresh", snapshot, {
      startupSessionMode: { type: "fresh" },
    });
    coordinator.promptStarted({
      clientId: "client_active",
      options: { sessionId: "session_1" } satisfies SubmitPromptOptions,
      sessionId: "session_1",
      text: "hello",
    });
    coordinator.observeEvent(runUpdated("run_1", "session_1"));

    expect(
      coordinator.routeEventForClient(runtimeRunning("run_1"), "client_active"),
    ).toEqual(runtimeRunning("run_1"));
    expect(
      coordinator.routeEventForClient(runtimeRunning("run_1"), "client_fresh"),
    ).toBeUndefined();
  });
});
