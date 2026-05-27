import { describe, expect, it, vi } from "vitest";
import type {
  UiCommandInvocation,
  UiInteractionResponse,
  UiSnapshot,
} from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import { CommandsEvent, createCommandService } from "./index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";

type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

describe("CommandService", () => {
  it("lists permission commands in the builtin catalog", async () => {
    const { service } = createServiceHarness();

    const catalog = await service.listCommands({ surface: "tui" });

    expect(catalog.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "permission",
        "permission.default",
        "permission.full-access",
      ]),
    );
    expect(catalog.commands.map((command) => command.id)).not.toContain("mode");
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

  it("opens session selection from /session and lists sessions on non-TUI surfaces", async () => {
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
    await service.executeCommand({
      ...makeInvocation("session", ["session"]),
      surface: "headless",
    });

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

  it("creates and selects a new session", async () => {
    const createSession = vi.fn<() => Promise<{ id: string; title: string }>>(
      () => Promise.resolve({ id: "session_new", title: "New session" }),
    );
    const { events, service } = createServiceHarness({
      sessions: {
        createSession,
        listSessions() {
          return [];
        },
      },
    });

    await service.executeCommand(makeInvocation("session.new", ["new"]));

    expect(createSession).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: {
              session: { id: "session_new", title: "New session" },
            },
            kind: "data",
            subject: "session.created",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: { choiceId: "session_new" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("manually compacts the current session", async () => {
    const compactSession = vi.fn(() =>
      Promise.resolve({
        sessionId: "session_1",
        status: "compacted" as const,
        usageAfter: {
          contextLimit: 100,
          currentTokens: 24,
          modelId: "fake-model",
          remainingTokens: 76,
          shouldCompress: false,
          usageRatio: 0.24,
        },
        usageBefore: {
          contextLimit: 100,
          currentTokens: 92,
          modelId: "fake-model",
          remainingTokens: 8,
          shouldCompress: true,
          usageRatio: 0.92,
        },
      }),
    );
    const { events, service } = createServiceHarness({
      compact: {
        compactSession,
      },
    });

    await service.executeCommand(
      makeInvocation("session.compact", ["compact"], ["--force"]),
    );

    expect(compactSession).toHaveBeenCalledWith({
      force: true,
      sessionId: "session_1",
    });
    expect(
      events.some((event) => {
        const output = event.output;
        return (
          event.type === "result" &&
          isRecord(output) &&
          output.kind === "data" &&
          output.subject === "session.compact"
        );
      }),
    ).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: {
            data: { sessionId: "session_1", status: "compacted" },
            kind: "session.compacted",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("resumes a session from the top-level /resume command", async () => {
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
        ["resume"],
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

  it("fails /resume without an id instead of opening session selection", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("session.resume", ["resume"]));

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

  it("reports and updates permission mode and level", async () => {
    let permissionState: UiPermissionState = {
      level: "default",
      mode: "auto",
      sessionRules: [],
    };
    const toggleMode = vi.fn(() => {
      permissionState = {
        ...permissionState,
        mode: permissionState.mode === "auto" ? "plan" : "auto",
      };
      return permissionState.mode;
    });
    const setMode = vi.fn<(mode: UiPermissionState["mode"]) => void>((mode) => {
      permissionState = {
        ...permissionState,
        mode,
      };
    });
    const setLevel = vi.fn<(level: UiPermissionState["level"]) => void>(
      (level) => {
        permissionState = {
          ...permissionState,
          level,
        };
      },
    );
    const { events, service } = createServiceHarness({
      permission: {
        getState() {
          return permissionState;
        },
        setLevel,
        setMode,
        toggleMode,
      },
    });

    await service.executeCommand(
      makeInvocation("permission.toggle-mode", ["permission", "toggle-mode"]),
    );
    await service.executeCommand(
      makeInvocation("permission.full-access", ["permission", "full-access"]),
    );
    await service.executeCommand(
      makeInvocation("permission.default", ["permission", "default"]),
    );

    expect(toggleMode).toHaveBeenCalledOnce();
    expect(setMode).not.toHaveBeenCalled();
    expect(setLevel).toHaveBeenNthCalledWith(1, "full-access");
    expect(setLevel).toHaveBeenNthCalledWith(2, "default");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
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
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: {
              permission: {
                level: "default",
                mode: "plan",
                sessionRules: [],
              },
            },
            kind: "permission.mode.updated",
          },
          type: "result",
        }),
        expect.objectContaining({
          output: {
            data: {
              permission: {
                level: "full-access",
                mode: "plan",
                sessionRules: [],
              },
            },
            kind: "data",
            subject: "permission.level",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: {
              permission: {
                level: "default",
                mode: "plan",
                sessionRules: [],
              },
            },
            kind: "permission.level.updated",
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

  it("does not accept mode values as permission subcommands", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(
      makeInvocation("permission.plan", ["permission", "plan"]),
    );
    await service.executeCommand(
      makeInvocation("permission.auto", ["permission", "auto"]),
    );

    expect(events.at(1)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: permission.plan",
      },
      type: "failed",
    });
    expect(events.at(3)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: permission.auto",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
