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
      sessionId: "session_1",
      type: "message.part.delta",
    });
    await flush();

    expect(app.lastFrame()).toContain("Hello");
  });

  it("handles the backend streaming event sequence without duplicating text", async () => {
    const client = createFakeClient({
      activeSessionId: null,
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    });
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      session: {
        createdAt: "2026-05-14T00:00:00.000Z",
        id: "session_stream",
        messages: [],
        title: "Streaming",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
      type: "session.updated",
    });
    client.emit({
      message: {
        createdAt: "2026-05-14T00:00:01.000Z",
        id: "message_user",
        parts: [{ text: "start", type: "text" }],
        role: "user",
      },
      sessionId: "session_stream",
      type: "message.appended",
    });
    client.emit({
      run: {
        id: "run_stream",
        sessionId: "session_stream",
        startedAt: "2026-05-14T00:00:02.000Z",
        status: { kind: "running", runId: "run_stream" },
        updatedAt: "2026-05-14T00:00:02.000Z",
      },
      type: "run.updated",
    });
    client.emit({
      message: {
        createdAt: "2026-05-14T00:00:03.000Z",
        id: "message_assistant",
        parts: [],
        role: "assistant",
      },
      sessionId: "session_stream",
      type: "message.appended",
    });
    client.emit({
      message: {
        createdAt: "2026-05-14T00:00:03.000Z",
        id: "message_assistant",
        parts: [{ text: "Hel", type: "text" }],
        role: "assistant",
      },
      sessionId: "session_stream",
      type: "message.updated",
    });
    client.emit({
      content: "Hel",
      delta: "Hel",
      messageId: "message_assistant",
      sessionId: "session_stream",
      type: "message.part.delta",
    });
    client.emit({
      message: {
        createdAt: "2026-05-14T00:00:03.000Z",
        id: "message_assistant",
        parts: [{ text: "Hello", type: "text" }],
        role: "assistant",
      },
      sessionId: "session_stream",
      type: "message.updated",
    });
    client.emit({
      content: "Hello",
      delta: "lo",
      messageId: "message_assistant",
      sessionId: "session_stream",
      type: "message.part.delta",
    });
    client.emit({
      run: {
        id: "run_stream",
        sessionId: "session_stream",
        startedAt: "2026-05-14T00:00:02.000Z",
        status: { kind: "idle" },
        updatedAt: "2026-05-14T00:00:04.000Z",
      },
      type: "run.updated",
    });
    await flush();

    expect(app.lastFrame()).toContain("assistant");
    expect(app.lastFrame()).toContain("Hello");
    expect(app.lastFrame()).not.toContain("Hellolo");
    expect(app.lastFrame()).toContain("status: idle | session: session_stream");
  });

  it("renders tool calls and tool results as separate readable parts", async () => {
    const toolSnapshot = snapshot();
    const baseSession = toolSnapshot.sessions[0];
    const client = createFakeClient({
      ...toolSnapshot,
      sessions: [
        {
          ...baseSession,
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_tool",
              parts: [
                {
                  call: {
                    id: "call_1",
                    input: { command: "pwd" },
                    name: "bash",
                    status: "completed",
                  },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_1",
                    output: "D:/Projects",
                  },
                  type: "tool-result",
                },
              ],
              role: "assistant",
            },
          ],
        },
      ],
    });
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();

    expect(app.lastFrame()).toContain("tool bash (completed)");
    expect(app.lastFrame()).toContain("tool result call_1: D:/Projects");
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
      timestamp: 1,
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
      request: {
        commandRunId: "command_1",
        interactionId: "model_1",
        kind: "select-one",
        options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        subject: "model",
      },
      timestamp: 1,
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
      commandRunId: "command_1",
      interactionId: "model_1",
      status: "accepted",
      timestamp: 2,
      type: "interaction.resolved",
    });
    client.emit({
      request: {
        commandRunId: "command_2",
        interactionId: "session_chooser",
        kind: "select-one",
        options: [{ id: "session_1", label: "Main" }],
        subject: "session",
      },
      timestamp: 3,
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
      request: {
        commandRunId: "command_1",
        interactionId: "generic_1",
        kind: "select-one",
        options: [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
        prompt: "Provider",
        subject: "provider",
      },
      timestamp: 1,
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
      request: {
        commandRunId: "command_1",
        interactionId: "confirm_1",
        kind: "confirm",
        prompt: "Continue?",
        subject: "command",
      },
      timestamp: 1,
      type: "interaction.requested",
    });
    await flush();

    expect(app.lastFrame()).toContain("Confirm");
    app.stdin.write("\r");
    await flush();
    expect(client.respondInteraction).toHaveBeenCalledWith("confirm_1", {
      kind: "accepted",
      value: true,
    });
  });

  it("gives permission dialogs priority over interactions", async () => {
    const client = createFakeClient(snapshot());
    const app = render(<OhbabyTerminalApp client={client} />);

    await flush();
    client.emit({
      request: {
        commandRunId: "command_1",
        interactionId: "model_1",
        kind: "select-one",
        options: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        subject: "model",
      },
      timestamp: 1,
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
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
