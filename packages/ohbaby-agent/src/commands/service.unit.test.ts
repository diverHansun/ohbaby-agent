import { describe, expect, it, vi } from "vitest";
import type { UiCommandInvocation, UiInteractionResponse } from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import { CommandsEvent, createCommandService } from "./index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";

describe("CommandService", () => {
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
          return { id: "anthropic:claude", label: "Claude", provider: "anthropic" };
        },
        listModels() {
          return [
            { id: "anthropic:claude", label: "Claude", provider: "anthropic" },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("model.list", ["model", "list"]));
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
    const request = vi.fn<() => Promise<UiInteractionResponse>>().mockResolvedValue({
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

    const execution = service.executeCommand(makeInvocation("session", ["session"]));
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
): UiCommandInvocation {
  return {
    argv: [],
    clientInvocationId: "inv_1",
    commandId,
    path,
    raw: `/${path.join(" ")}`,
    rawArgs: "",
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
