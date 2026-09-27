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
        sessionId: "session_1",
        rootSessionId: "session_1",
        callId: "call_1",
        messageId: "message_1",
        createdAt: 1,
        runId: "run_1",
        title: "Tool permission",
      },
      {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Allow tool",
        id: "permission_2",
        sessionId: "session_2",
        rootSessionId: "session_2",
        callId: "call_2",
        messageId: "message_2",
        createdAt: 2,
        runId: "run_2",
        title: "Tool permission",
      },
    ],
    prompts: [
      {
        clientRequestId: "request_1",
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
        clientRequestId: "request_2",
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

function commandStarted(): Extract<UiEvent, { type: "command.started" }> {
  return {
    command: {
      clientInvocationId: "invoke_1",
      commandId: "status",
      commandRunId: "command_1",
      path: ["status"],
      surface: "tui",
    },
    timestamp: Date.parse(timestamp),
    type: "command.started",
  };
}

function interactionRequested(): Extract<
  UiEvent,
  { type: "interaction.requested" }
> {
  return {
    request: {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      interactionId: "interaction_1",
      kind: "confirm",
      subject: "permission",
    },
    timestamp: Date.parse(timestamp),
    type: "interaction.requested",
  };
}

function interactionResolved(
  status: "accepted" | "cancelled" = "accepted",
): Extract<UiEvent, { type: "interaction.resolved" }> {
  return {
    clientInvocationId: "invoke_1",
    commandRunId: "command_1",
    interactionId: "interaction_1",
    status,
    timestamp: Date.parse(timestamp),
    type: "interaction.resolved",
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
      permissions: [],
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
      status: { kind: "waiting-for-permission", requestId: "permission_1" },
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

    expect(prepared).toMatchObject({
      options: { sessionId: "session_generated" },
      sessionId: "session_generated",
    });
    expect(
      coordinator.projectSnapshot("client_a", emptySnapshot()).activeSessionId,
    ).toBe("session_generated");
  });

  it("keeps an explicitly submitted prompt visible before its session appears", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.initializeClient("client_a", emptySnapshot(), {
      startupSessionMode: { type: "fresh" },
    });
    coordinator.preparePromptSubmit(
      "client_a",
      { sessionId: "session_explicit" },
      () => "unused",
    );
    const snapshot = {
      ...emptySnapshot(),
      prompts: [
        {
          clientRequestId: "request_1",
          createdAt: timestamp,
          promptId: "prompt_1",
          scopeKey: "/repo",
          sessionId: "session_explicit",
          status: "queued" as const,
          text: "hello",
          updatedAt: timestamp,
          userMessageId: "message_1",
        },
      ],
    };

    expect(coordinator.projectSnapshot("client_a", snapshot)).toMatchObject({
      activeSessionId: "session_explicit",
      prompts: [{ promptId: "prompt_1" }],
    });
    expect(coordinator.canAccessPrompt("client_a", snapshot, "prompt_1")).toBe(
      true,
    );
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

  it("atomically claims an interaction only for its command owner", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());

    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_b",
        () => "claim_wrong",
      ),
    ).toBeUndefined();
    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_1",
      ),
    ).toEqual({ claimToken: "claim_1" });
    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_2",
      ),
    ).toBeUndefined();
  });

  it("rolls back only the matching live interaction claim", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());
    const claim = coordinator.claimInteractionResponse(
      "interaction_1",
      "client_a",
      () => "claim_1",
    );
    if (claim === undefined) {
      throw new Error("expected interaction claim");
    }

    expect(coordinator.releaseInteractionClaim("interaction_1", "wrong")).toBe(
      false,
    );
    expect(
      coordinator.releaseInteractionClaim("interaction_1", claim.claimToken),
    ).toBe(true);
    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_2",
      ),
    ).toEqual({ claimToken: "claim_2" });
  });

  it("does not restore a claim after the interaction resolved", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());
    const claim = coordinator.claimInteractionResponse(
      "interaction_1",
      "client_a",
      () => "claim_1",
    );
    if (claim === undefined) {
      throw new Error("expected interaction claim");
    }

    coordinator.observeEvent(interactionResolved());

    expect(
      coordinator.releaseInteractionClaim("interaction_1", claim.claimToken),
    ).toBe(false);
    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_2",
      ),
    ).toBeUndefined();
  });

  it("clears interaction ownership for cancelled terminal events", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());

    coordinator.observeEvent(interactionResolved("cancelled"));

    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_after_abort_or_timeout",
      ),
    ).toBeUndefined();
  });

  it("does not restore a claim after client removal wins the race", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());
    const claim = coordinator.claimInteractionResponse(
      "interaction_1",
      "client_a",
      () => "claim_1",
    );
    if (claim === undefined) {
      throw new Error("expected interaction claim");
    }

    expect(coordinator.disconnectClient("client_a")).toEqual(["interaction_1"]);

    expect(
      coordinator.releaseInteractionClaim("interaction_1", claim.claimToken),
    ).toBe(false);
    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_2",
      ),
    ).toBeUndefined();
  });

  it("retains the client projection when routing owners are disconnected", () => {
    const coordinator = new DaemonClientViewCoordinator();
    const snapshot = snapshotWithSessions();
    coordinator.initializeClient("client_a", snapshot, {
      resumeSessionId: "session_2",
    });

    coordinator.disconnectClient("client_a");

    expect(coordinator.projectSnapshot("client_a", snapshot)).toMatchObject({
      activeSessionId: "session_2",
      sessions: [
        { id: "session_1", messages: [] },
        {
          id: "session_2",
          messages: [textMessage("message_2", "hidden transcript")],
        },
      ],
    });
  });

  it("clears interaction ownership when runtime state resets on shutdown", () => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.prepareCommandInvocation("client_a", commandInvocation());
    coordinator.observeEvent(commandStarted());
    coordinator.observeEvent(interactionRequested());

    coordinator.resetRuntimeState();

    expect(
      coordinator.claimInteractionResponse(
        "interaction_1",
        "client_a",
        () => "claim_after_shutdown",
      ),
    ).toBeUndefined();
  });
});

it.each([
  { outcomes: [false, false], order: [0, 1], root: null },
  { outcomes: [false, false], order: [1, 0], root: null },
  { outcomes: [false, true], order: [0, 1], root: "provisional" },
  { outcomes: [false, true], order: [1, 0], root: "provisional" },
])(
  "settles concurrent provisional prompt admissions without losing successful bindings ($outcomes, $order)",
  ({ outcomes, order, root }) => {
    const coordinator = new DaemonClientViewCoordinator();
    coordinator.initializeClient("client", emptySnapshot(), {
      startupSessionMode: { type: "fresh" },
    });
    const first = coordinator.preparePromptSubmit(
      "client",
      undefined,
      () => "provisional",
    );
    const second = coordinator.preparePromptSubmit(
      "client",
      undefined,
      () => "unused",
    );
    const prepared = [first, second];
    prepared[order[0]].finishAdmission(outcomes[order[0]]);
    if (!outcomes[order[0]])
      expect(coordinator.isPromptBindingProvisional("client")).toBe(true);
    prepared[order[1]].finishAdmission(outcomes[order[1]]);
    expect(coordinator.binding("client", "epoch")).toMatchObject({
      rootSessionId: root,
      bindingGeneration: 3,
    });
    expect(coordinator.isPromptBindingProvisional("client")).toBe(false);
    if (root === null)
      expect(
        coordinator.preparePromptSubmit("client", undefined, () => "next")
          .sessionId,
      ).toBe("next");
  },
);

it("does not roll back a concurrent explicit session selection when admission fails", () => {
  const coordinator = new DaemonClientViewCoordinator();
  coordinator.initializeClient("client", emptySnapshot(), {
    startupSessionMode: { type: "fresh" },
  });
  const prepared = coordinator.preparePromptSubmit(
    "client",
    undefined,
    () => "provisional",
  );
  coordinator.selectSession("client", "other", 2);
  prepared.finishAdmission(false);
  expect(coordinator.binding("client", "epoch")).toMatchObject({
    rootSessionId: "other",
    bindingGeneration: 3,
  });
  expect(coordinator.isPromptBindingProvisional("client")).toBe(false);
});

it("preserves an in-flight provisional admission when invalid registration fails", () => {
  const coordinator = new DaemonClientViewCoordinator();
  coordinator.initializeClient("client", emptySnapshot(), {
    startupSessionMode: { type: "fresh" },
  });
  const prepared = coordinator.preparePromptSubmit(
    "client",
    undefined,
    () => "provisional",
  );
  expect(() => {
    coordinator.initializeClient("client", emptySnapshot(), {
      resumeSessionId: "missing",
    });
  }).toThrow("Session not found");
  prepared.finishAdmission(false);
  expect(coordinator.binding("client", "epoch")).toMatchObject({
    rootSessionId: null,
    bindingGeneration: 3,
  });
  expect(coordinator.isPromptBindingProvisional("client")).toBe(false);
});

describe("DaemonClientViewCoordinator sessionIdsBoundByOtherClients", () => {
  it("lists other live clients' roots and forgets disconnected clients", () => {
    const views = new DaemonClientViewCoordinator();
    const intent = { startupSessionMode: { type: "fresh" } } as const;
    views.initializeClient("a", { sessions: [] }, intent);
    views.initializeClient("b", { sessions: [] }, intent);
    views.selectSession(
      "a",
      "session_a",
      views.binding("a", "e").bindingGeneration,
    );
    views.selectSession(
      "b",
      "session_b",
      views.binding("b", "e").bindingGeneration,
    );

    expect(views.sessionIdsBoundByOtherClients("a")).toEqual(["session_b"]);
    views.disconnectClient("b");
    expect(views.sessionIdsBoundByOtherClients("a")).toEqual([]);
    views.initializeClient("b", { sessions: [] }, intent);
    views.selectSession(
      "b",
      "session_b",
      views.binding("b", "e").bindingGeneration,
    );
    expect(views.sessionIdsBoundByOtherClients("a")).toEqual(["session_b"]);
  });
});

describe("short session admissions", () => {
  it("retains every in-flight target after SSE occupancy ends, including concurrent requests", () => {
    const views = new DaemonClientViewCoordinator();
    views.initializeClient("owner", { sessions: [] }, {});
    const finishFirst = views.beginSessionOperation("owner", "target");
    const finishSecond = views.beginSessionOperation("owner", "target");
    views.setClientSessionOccupancy("owner", false);
    expect(views.protectedSessionIds()).toEqual(["target"]);
    finishSecond();
    finishSecond();
    expect(views.protectedSessionIds()).toEqual(["target"]);
    expect(views.hasPendingSessionOperation("owner")).toBe(true);
    finishFirst();
    expect(views.protectedSessionIds()).toEqual([]);
    expect(views.hasPendingSessionOperation("owner")).toBe(false);
  });
  it("invalidates an empty check even when an intervening admission has already settled", () => {
    const views = new DaemonClientViewCoordinator();
    const revision = views.sessionAdmissionRevision;
    const finish = views.beginSessionOperation("owner", "target");
    finish();
    expect(views.sessionAdmissionRevision).toBeGreaterThan(revision);
  });
});
