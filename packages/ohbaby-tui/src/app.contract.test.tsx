import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEventHandler, UiSnapshot } from "ohbaby-sdk";
import { OhbabyTerminalApp } from "./index.js";
import type {
  TuiBackendClient,
  TuiCommandCatalog,
  TuiEvent,
  TuiEventHandler,
} from "./store/snapshot.js";

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
            parts: [{ text: "Hel", type: "text" }],
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

const catalog: TuiCommandCatalog = {
  commands: [
    {
      acceptsArguments: true,
      description: "Open model switcher",
      id: "model.switch",
      path: ["model", "switch"],
      surfaces: ["tui"],
    },
    {
      description: "Resume a session",
      id: "session.resume",
      path: ["session", "resume"],
      surfaces: ["tui"],
    },
  ],
  loadedAt: 1_771_000_000_000,
  surface: "tui",
  version: "v1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OhbabyTerminalApp", () => {
  it("renders snapshot messages and applies assistant deltas", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    expect(app.lastFrame()).toContain("assistant");
    expect(app.lastFrame()).toContain("Hel");

    client.emit({
      delta: "lo",
      messageId: "message_1",
      partIndex: 0,
      sessionId: "session_1",
      type: "message.part.delta",
    });
    await flush();

    expect(app.lastFrame()).toContain("Hello");
  });

  it("submits normal prompts with the active session id", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    app.stdin.write("hello");
    app.stdin.write("\r");
    await flush();

    expect(client.submitPrompt).toHaveBeenCalledWith("hello", {
      sessionId: "session_1",
    });
  });

  it("executes exact slash commands but only completes on tab", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    app.stdin.write("/ses");
    app.stdin.write("\t");
    await flush();
    expect(app.lastFrame()).toContain("/session resume ");
    expect(client.executeCommand).not.toHaveBeenCalled();

    app.stdin.write("\u0015");
    app.stdin.write("/model switch gpt-5.5");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["gpt-5.5"],
        commandId: "model.switch",
        sessionId: "session_1",
      }),
    );
  });

  it("reloads the command catalog after invalidation events", async () => {
    const client = createFakeClient(snapshot(), catalog);
    render(<OhbabyTerminalApp client={client} />);

    await flush();
    expect(client.listCommands).toHaveBeenCalledTimes(1);

    client.emit({
      reason: "commands changed",
      type: "command.catalog.updated",
      version: "v2",
    });
    await flush();

    expect(client.listCommands).toHaveBeenCalledTimes(2);
  });

  it("opens model and session interactions and sends responses", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      interaction: {
        interactionId: "model_1",
        kind: "select-one",
        options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        subject: "model",
      },
      type: "interaction.requested",
    });
    await flush();
    expect(app.lastFrame()).toContain("Model");

    app.stdin.write("\r");
    await flush();
    expect(client.respondInteraction).toHaveBeenCalledWith("model_1", {
      choiceId: "gpt-5.5",
      kind: "accepted",
    });

    client.emit({
      interactionId: "model_1",
      type: "interaction.resolved",
    });
    client.emit({
      interaction: {
        interactionId: "session_chooser",
        kind: "select-one",
        options: [{ id: "session_1", label: "Main" }],
        subject: "session",
      },
      type: "interaction.requested",
    });
    await flush();
    expect(app.lastFrame()).toContain("Session");
  });

  it("supports selection movement for generic select-one interactions", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      interaction: {
        interactionId: "generic_1",
        kind: "select-one",
        options: [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
        subject: "provider",
        title: "Provider",
      },
      type: "interaction.requested",
    });
    await flush();

    expect(app.lastFrame()).toContain("Provider");
    app.stdin.write("2");
    await flush();
    app.stdin.write("\r");
    await flush();

    expect(client.respondInteraction).toHaveBeenCalledWith("generic_1", {
      choiceId: "second",
      kind: "accepted",
    });
  });

  it("opens confirm interactions and sends confirmation responses", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      interaction: {
        interactionId: "confirm_1",
        kind: "confirm",
        message: "Continue?",
        subject: "command",
      },
      type: "interaction.requested",
    });
    await flush();

    expect(app.lastFrame()).toContain("Confirm");
    app.stdin.write("\r");
    await flush();
    expect(client.respondInteraction).toHaveBeenCalledWith("confirm_1", {
      kind: "confirmed",
    });
  });

  it("gives permission dialogs priority over interactions", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      interaction: {
        interactionId: "model_1",
        kind: "select-one",
        options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        subject: "model",
      },
      type: "interaction.requested",
    });
    client.emit({
      request: {
        choices: [{ id: "allow", intent: "allow", label: "Allow" }],
        description: "Run bash",
        id: "permission_1",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });
    await flush();

    expect(app.lastFrame()).toContain("Permission");
    expect(app.lastFrame()).not.toContain("Model");

    app.stdin.write("\r");
    await flush();
    expect(client.respondPermission).toHaveBeenCalledWith("permission_1", {
      choiceId: "allow",
    });
  });

  it("defaults permission selection to deny when available", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      request: {
        choices: [
          { id: "allow", intent: "allow", label: "Allow" },
          { id: "deny", intent: "deny", label: "Deny" },
        ],
        description: "Run bash",
        id: "permission_2",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });
    await flush();

    app.stdin.write("\r");
    await flush();
    expect(client.respondPermission).toHaveBeenCalledWith("permission_2", {
      choiceId: "deny",
    });
  });
});

function createFakeClient(
  initialSnapshot: UiSnapshot,
  commandCatalog: TuiCommandCatalog = catalog,
): TuiBackendClient & {
  readonly emit: (event: TuiEvent) => void;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly submitPrompt: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<TuiEventHandler>();

  return {
    abortRun: vi.fn(() => Promise.resolve()),
    emit(event): void {
      for (const handler of handlers) {
        handler(event);
      }
    },
    executeCommand: vi.fn(() => Promise.resolve()),
    getSnapshot: vi.fn(() => Promise.resolve(initialSnapshot)),
    listCommands: vi.fn(() => Promise.resolve(commandCatalog)),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    submitPrompt: vi.fn(() => Promise.resolve()),
    subscribeEvents(handler: TuiEventHandler | UiEventHandler): () => void {
      const tuiHandler = handler as TuiEventHandler;

      handlers.add(tuiHandler);
      return () => {
        handlers.delete(tuiHandler);
      };
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
