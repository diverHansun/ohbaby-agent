import { describe, expect, it, vi } from "vitest";
import type {
  UiCommandInvocation,
  UiInteractionResponse,
  UiSnapshot,
} from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import { CommandsEvent, createCommandService } from "./index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";

type UiPolicyState = NonNullable<UiSnapshot["policy"]>;

describe("CommandService", () => {
  it("lists mode commands in the builtin catalog", async () => {
    const { service } = createServiceHarness();

    const catalog = await service.listCommands({ surface: "tui" });

    expect(catalog.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "mode",
        "mode.agent",
        "mode.ask",
        "mode.plan",
        "permission",
        "permission.ask-before-edit",
        "permission.edit-automatically",
      ]),
    );
    expect(catalog.commands.map((command) => command.id)).not.toContain(
      "mode.auto-edit",
    );
  });

  it("executes status and publishes command events", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("status", ["status"]));

    expect(events).toEqual([
      expect.objectContaining({
        commandId: "status",
        commandRunId: "command_1",
        type: "started",
      }),
      expect.objectContaining({
        commandRunId: "command_1",
        output: { kind: "data", subject: "status", data: { status: "idle" } },
        type: "result",
      }),
    ]);
  });

  it("lists tools from the configured tool provider", async () => {
    const { events, service } = createServiceHarness({
      tools: {
        listTools() {
          return [
            {
              name: "read",
              description: "Read a file",
              category: "readonly",
              source: "builtin",
            },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("tools", ["tools"]));

    expect(events.at(-1)).toMatchObject({
      output: {
        kind: "data",
        subject: "tools",
        data: {
          tools: [
            {
              name: "read",
              description: "Read a file",
              category: "readonly",
              source: "builtin",
            },
          ],
        },
      },
      type: "result",
    });
  });

  it("reports the configured model for the model parent command", async () => {
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return { id: "openai:gpt-5.5", label: "GPT-5.5", provider: "openai" };
        },
        listModels() {
          return [
            { id: "openai:gpt-5.5", label: "GPT-5.5", provider: "openai" },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("model", ["model"]));

    expect(events.at(-1)).toMatchObject({
      output: {
        data: {
          model: {
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
        subject: "model.current",
      },
      type: "result",
    });
  });

  it("publishes model list and current model data", async () => {
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return {
            id: "anthropic:claude",
            label: "Claude",
            provider: "anthropic",
          };
        },
        listModels() {
          return [
            { id: "anthropic:claude", label: "Claude", provider: "anthropic" },
          ];
        },
      },
    });

    await service.executeCommand(
      makeInvocation("model.list", ["model", "list"]),
    );
    await service.executeCommand(
      makeInvocation("model.current", ["model", "current"]),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            kind: "data",
            subject: "model.list",
            data: {
              models: [
                {
                  id: "anthropic:claude",
                  label: "Claude",
                  provider: "anthropic",
                },
              ],
            },
          },
        }),
        expect.objectContaining({
          output: {
            kind: "data",
            subject: "model.current",
            data: {
              model: {
                id: "anthropic:claude",
                label: "Claude",
                provider: "anthropic",
              },
            },
          },
        }),
      ]),
    );
  });

  it("opens session selection and lists sessions", async () => {
    const request = vi
      .fn<() => Promise<UiInteractionResponse>>()
      .mockResolvedValue({
        choiceId: "session_1",
        kind: "accepted",
      });
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      interactionBroker: { request },
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
        selectSession,
      },
    });

    await service.executeCommand(makeInvocation("session", ["session"]));
    await service.executeCommand(
      makeInvocation("session.list", ["session", "list"]),
    );

    expect(request).toHaveBeenCalledWith(
      {
        kind: "select-one",
        options: [{ id: "session_1", label: "First" }],
        prompt: "Select session",
        subject: "session",
      },
      expect.objectContaining({ commandRunId: "command_1" }),
    );
    expect(selectSession).toHaveBeenCalledWith("session_1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: {
            data: { choiceId: "session_1" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      output: {
        kind: "data",
        subject: "session.list",
        data: { sessions: [{ id: "session_1", title: "First" }] },
      },
      type: "result",
    });
  });

  it("resumes a session by --session_id or positional id", async () => {
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      sessions: {
        listSessions() {
          return [
            { id: "session_1", title: "First" },
            { id: "session_2", title: "Second" },
          ];
        },
        selectSession,
      },
    });

    await service.executeCommand(
      makeInvocation(
        "session.resume",
        ["session", "resume"],
        ["--session_id", "session_2"],
      ),
    );
    await service.executeCommand(
      makeInvocation("session.resume", ["resume"], ["session_1"]),
    );

    expect(selectSession).toHaveBeenNthCalledWith(1, "session_2");
    expect(selectSession).toHaveBeenNthCalledWith(2, "session_1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: { sessionId: "session_2" },
            kind: "data",
            subject: "session.current",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: { choiceId: "session_1" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("fails session resume without an id on non-interactive surfaces", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand({
      ...makeInvocation("session.resume", ["session", "resume"]),
      surface: "headless",
    });

    expect(events.at(-1)).toMatchObject({
      error: {
        code: "SESSION_ID_REQUIRED",
        message: "Use /resume --session_id <id> to resume a session",
      },
      type: "failed",
    });
  });

  it("rejects session selections that were not offered", async () => {
    const request = vi
      .fn<() => Promise<UiInteractionResponse>>()
      .mockResolvedValue({
        choiceId: "session_missing",
        kind: "accepted",
      });
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      interactionBroker: { request },
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
        selectSession,
      },
    });

    await service.executeCommand(makeInvocation("session", ["session"]));

    expect(selectSession).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      error: {
        code: "INVALID_INTERACTION_RESPONSE",
        message: "Unknown session selection: session_missing",
      },
      type: "failed",
    });
  });

  it("executes abort and exit actions", async () => {
    const abortRun = vi.fn<() => Promise<void>>().mockResolvedValue();
    const exit = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({ abortRun, exit });

    await service.executeCommand(makeInvocation("abort", ["abort"]));
    await service.executeCommand(makeInvocation("exit", ["exit"]));

    expect(abortRun).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: { kind: "run.abort" },
          type: "result",
        }),
        expect.objectContaining({
          action: { kind: "app.exit" },
          type: "result",
        }),
      ]),
    );
  });

  it("reports and updates policy mode", async () => {
    let policyState: UiPolicyState = {
      agentState: "ask-before-edit",
      mode: "agent",
    };
    const setMode = vi.fn<(mode: UiPolicyState["mode"]) => void>((mode) => {
      policyState = {
        agentState: "ask-before-edit",
        mode,
      };
    });
    const setAgentState = vi.fn<
      (state: UiPolicyState["agentState"]) => void
    >((agentState) => {
      if (agentState === "edit-automatically" && policyState.mode !== "agent") {
        return;
      }
      policyState = {
        agentState,
        mode: policyState.mode,
      };
    });
    const { events, service } = createServiceHarness({
      policy: {
        getState() {
          return policyState;
        },
        setMode,
        setAgentState,
      },
    });

    await service.executeCommand(makeInvocation("mode", ["mode"]));
    await service.executeCommand(makeInvocation("mode.ask", ["mode", "ask"]));
    await service.executeCommand(
      makeInvocation("permission", ["permission"]),
    );
    await service.executeCommand(
      makeInvocation("permission.edit-automatically", [
        "permission",
        "edit-automatically",
      ]),
    );
    await service.executeCommand(
      makeInvocation("permission.ask-before-edit", [
        "permission",
        "ask-before-edit",
      ]),
    );

    expect(setMode).toHaveBeenCalledWith("ask");
    expect(setMode).not.toHaveBeenCalledWith("agent");
    expect(setAgentState).toHaveBeenNthCalledWith(1, "edit-automatically");
    expect(setAgentState).toHaveBeenNthCalledWith(2, "ask-before-edit");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: {
              policy: {
                agentState: "ask-before-edit",
                mode: "agent",
              },
            },
            kind: "data",
            subject: "policy.mode",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: {
              policy: {
                agentState: "ask-before-edit",
                mode: "ask",
              },
            },
            kind: "policy.mode.updated",
          },
          type: "result",
        }),
        expect.objectContaining({
          output: {
            data: {
              policy: {
                agentState: "ask-before-edit",
                mode: "ask",
              },
            },
            kind: "data",
            subject: "policy.permission",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: {
              policy: {
                agentState: "ask-before-edit",
                mode: "ask",
              },
            },
            kind: "policy.permission.updated",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("publishes command.failed for unknown command ids", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("missing", ["missing"]));

    expect(events.at(-1)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: missing",
      },
      type: "failed",
    });
  });

  it("executes handlers registered with extra command specs", async () => {
    const { events, service } = createServiceHarness({
      extraCommands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Show diagnostics",
          id: "diagnostics",
          path: ["diagnostics"],
          source: "plugin",
          surfaces: ["tui"],
        },
      ],
      extraHandlers: [
        {
          id: "diagnostics",
          execute(_invocation, context): void {
            context.emitOutput({
              kind: "data",
              subject: "diagnostics",
              data: { ok: true },
            });
          },
        },
      ],
    });

    expect((await service.listCommands({ surface: "tui" })).commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "diagnostics",
          path: ["diagnostics"],
        }),
      ]),
    );

    await service.executeCommand(
      makeInvocation("diagnostics", ["diagnostics"]),
    );

    expect(events.at(-1)).toMatchObject({
      output: {
        data: { ok: true },
        kind: "data",
        subject: "diagnostics",
      },
      type: "result",
    });
  });

  it("aborts pending command interactions by command run", async () => {
    const bus = createBus();
    const broker = createInteractionBroker({
      bus,
      createInteractionId: () => "interaction_1",
    });
    const events: Record<string, unknown>[] = [];
    bus.subscribe(CommandsEvent.Started, (event) => {
      events.push({ ...event, type: "started" });
    });
    bus.subscribe(CommandsEvent.Failed, (event) => {
      events.push({ ...event, type: "failed" });
    });
    const service = createCommandService({
      bus,
      createCommandRunId: createSequence("command"),
      interactionBroker: broker,
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
      },
    });

    const execution = service.executeCommand(
      makeInvocation("session", ["session"]),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(broker.listPending()).toEqual([
      expect.objectContaining({
        commandRunId: "command_1",
        interactionId: "interaction_1",
      }),
    ]);
    expect(service.abortCommandRun("command_1", "aborted")).toBe(1);
    await execution;

    expect(events.at(-1)).toMatchObject({
      commandRunId: "command_1",
      error: {
        code: "INTERACTION_CANCELLED",
        message: "Session selection cancelled: aborted",
      },
      type: "failed",
    });
  });
});

function createServiceHarness(
  overrides: Partial<Parameters<typeof createCommandService>[0]> = {},
): {
  readonly events: Record<string, unknown>[];
  readonly service: ReturnType<typeof createCommandService>;
} {
  const bus = createBus();
  const events: Record<string, unknown>[] = [];
  bus.subscribe(CommandsEvent.Started, (event) => {
    events.push({ ...event, type: "started" });
  });
  bus.subscribe(CommandsEvent.ResultDelivered, (event) => {
    events.push({ ...event, type: "result" });
  });
  bus.subscribe(CommandsEvent.Failed, (event) => {
    events.push({ ...event, type: "failed" });
  });

  return {
    events,
    service: createCommandService({
      bus,
      createCommandRunId: createSequence("command"),
      now: () => 1_000,
      ...overrides,
    }),
  };
}

function makeInvocation(
  commandId: string,
  path: readonly string[],
  argv: readonly string[] = [],
): UiCommandInvocation {
  return {
    argv,
    clientInvocationId: "inv_1",
    commandId,
    path,
    raw: `/${path.join(" ")}${argv.length > 0 ? ` ${argv.join(" ")}` : ""}`,
    rawArgs: argv.join(" "),
    sessionId: "session_1",
    surface: "tui",
  };
}

function createSequence(prefix: string): () => string {
  let next = 1;
  return () => {
    const id = `${prefix}_${String(next)}`;
    next += 1;
    return id;
  };
}
