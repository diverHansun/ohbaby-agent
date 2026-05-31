import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEventHandler, UiSnapshot } from "ohbaby-sdk";
import { OhbabyTerminalApp } from "./index.js";
import type {
  TerminalClient,
  TuiCommandCatalog,
  TuiCommandSpec,
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
    command({
      description: "Show current model",
      id: "models",
      path: ["models"],
    }),
    command({
      acceptsArguments: true,
      description: "Resume a session",
      id: "resume",
      path: ["resume"],
    }),
    command({
      description: "Choose a session",
      id: "sessions",
      path: ["sessions"],
    }),
    command({
      description: "Start a new session",
      id: "new",
      path: ["new"],
    }),
    command({
      description: "Choose permission level",
      id: "permission",
      path: ["permission"],
    }),
  ],
  loadedAt: 1_771_000_000_000,
  surface: "tui",
  version: "v1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OhbabyTerminalApp", () => {
  it("renders an empty-state logo and branded prompt", async () => {
    const client = createFakeClient({
      activeSessionId: null,
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();

    expect(app.lastFrame()).toContain("OHBABY");
    expect(app.lastFrame()).toContain("ohbaby > message |");
  });

  it("renders typed prompt text with a visible cursor", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("hello");
    await flush();

    expect(app.lastFrame()).toContain("ohbaby > hello |");
  });

  it("renders snapshot messages and applies assistant deltas", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    expect(app.lastFrame()).toContain("ohbaby");
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

  it("renders UI notices from the backend", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    client.emit({
      notice: {
        createdAt: "2026-05-19T00:00:00.000Z",
        id: "notice_1",
        key: "provider:missing-key",
        level: "error",
        message: "OPENAI_API_KEY is not configured",
        title: "Provider configuration failed",
      },
      timestamp: 1,
      type: "notice.emitted",
    });
    await flush();

    expect(app.lastFrame()).toContain("Provider configuration failed");
    expect(app.lastFrame()).toContain("OPENAI_API_KEY is not configured");
  });

  it("shows a readable status error when the initial snapshot fails", async () => {
    const client = {
      ...createFakeClient(snapshot()),
      getSnapshot: vi.fn(() =>
        Promise.reject(new Error("snapshot unavailable")),
      ),
    };
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();

    expect(app.lastFrame()).toContain("status: error: snapshot unavailable");
  });

  it("shows a readable status error when command catalog loading fails", async () => {
    const client = {
      ...createFakeClient(snapshot()),
      listCommands: vi.fn(() =>
        Promise.reject(new Error("command catalog unavailable")),
      ),
    };
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();

    expect(app.lastFrame()).toContain(
      "status: error: command catalog unavailable",
    );
  });

  it("renders permission state below the prompt and updates it from backend events", async () => {
    const client = createFakeClient({
      ...snapshot(),
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    expect(app.lastFrame()).toContain("mode: auto | level: default");
    expect(app.lastFrame()).not.toContain(
      "status: idle | session: session_1 | mode:",
    );
    expect(
      lineIndex(app.lastFrame(), "mode: auto | level: default"),
    ).toBeLessThan(
      lineIndex(app.lastFrame(), "status: idle | session: session_1"),
    );

    client.emit({
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
    await flush();

    expect(app.lastFrame()).toContain("mode: plan | level: full-access");
  });

  it("toggles permission mode with Shift+Tab", async () => {
    const client = createFakeClient({
      ...snapshot(),
      permission: {
        level: "default",
        mode: "auto",
        sessionRules: [],
      },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("\u001B[Z");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [],
        commandId: "permission.toggle-mode",
        path: ["permission", "toggle-mode"],
        raw: "<shift-tab>",
        sessionId: "session_1",
        surface: "tui",
      }),
    );
  });

  it("handles the backend streaming event sequence without duplicating text", async () => {
    const client = createFakeClient({
      activeSessionId: null,
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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

    expect(app.lastFrame()).toContain("ohbaby");
    expect(app.lastFrame()).toContain("Hello");
    expect(app.lastFrame()).not.toContain("Hellolo");
    expect(app.lastFrame()).toContain("status: idle | session: session_stream");
  });

  it("renders tool calls and tool result status without raw result output", async () => {
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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();

    expect(app.lastFrame()).toContain("tool bash (completed)");
    expect(app.lastFrame()).toContain('input: {"command":"pwd"}');
    expect(app.lastFrame()).toContain("tool result call_1 (completed)");
    expect(app.lastFrame()).toContain("result hidden");
    expect(app.lastFrame()).not.toContain("output: D:/Projects");
    expect(app.lastFrame()).not.toContain("D:/Projects");
  });

  it("hides raw web search result bodies in tool rendering", async () => {
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
              id: "message_search_tool",
              parts: [
                {
                  call: {
                    id: "call_search",
                    input: { query: "secret query" },
                    name: "web_search",
                    status: "completed",
                  },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_search",
                    output:
                      "Sensitive search body that should stay in model context only.",
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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();

    expect(app.lastFrame()).toContain("tool web_search (completed)");
    expect(app.lastFrame()).toContain("tool result call_search (completed)");
    expect(app.lastFrame()).toContain("result hidden");
    expect(app.lastFrame()).not.toContain("Sensitive search body");
  });

  it("uses readable runtime labels without raw run or permission ids", async () => {
    const client = createFakeClient({
      ...snapshot(),
      runs: [
        {
          id: "run_raw_123",
          sessionId: "session_1",
          startedAt: "2026-05-14T00:00:03.000Z",
          status: { kind: "running", runId: "run_raw_123" },
          updatedAt: "2026-05-14T00:00:03.000Z",
        },
      ],
      status: { kind: "running", runId: "run_raw_123" },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    expect(app.lastFrame()).toContain("status: running");
    expect(app.lastFrame()).not.toContain("run_raw_123");

    client.emit({
      request: {
        choices: [
          { id: "allow_once", intent: "allow", label: "Allow once" },
          { id: "reject", intent: "deny", label: "Reject" },
        ],
        description: "tool:write",
        id: "permission_raw_123",
        runId: "run_raw_123",
        title: "Write file",
      },
      type: "permission.requested",
    });
    await flush();

    expect(app.lastFrame()).toContain("status: waiting: Write file");
    expect(app.lastFrame()).not.toContain("permission_raw_123");
    expect(app.lastFrame()).toContain("Enter select");
    expect(app.lastFrame()).toContain("Esc safe default");
    expect(app.lastFrame()).toContain("> Reject [deny]");
    expect(app.lastFrame()).toContain("  Allow once [allow]");
  });

  it("submits normal prompts with the active session id", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("hello");
    app.stdin.write("\r");
    await flush();

    expect(client.submitPrompt).toHaveBeenCalledWith("hello", {
      sessionId: "session_1",
    });
  });

  it("clears submitted prompts immediately and surfaces concurrent submit errors", async () => {
    const client = createFakeClient(snapshot());
    client.submitPrompt
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockRejectedValueOnce(new Error("A prompt is already running"));
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("first");
    app.stdin.write("\r");
    await flush();

    expect(client.submitPrompt).toHaveBeenCalledWith("first", {
      sessionId: "session_1",
    });
    expect(app.lastFrame()).not.toContain("first");

    app.stdin.write("second");
    app.stdin.write("\r");
    await flush();
    await flush();

    expect(client.submitPrompt).toHaveBeenCalledWith("second", {
      sessionId: "session_1",
    });
    expect(app.lastFrame()).toContain("A prompt is already running");
  });

  it("aborts the active run on Ctrl+C when no dialog is open", async () => {
    const client = createFakeClient({
      ...snapshot(),
      runs: [
        {
          id: "run_1",
          sessionId: "session_1",
          startedAt: "2026-05-14T00:00:03.000Z",
          status: { kind: "running", runId: "run_1" },
          updatedAt: "2026-05-14T00:00:03.000Z",
        },
      ],
      status: { kind: "running", runId: "run_1" },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("\u0003");
    await flush();

    expect(client.abortRun).toHaveBeenCalledWith("run_1");
  });

  it("aborts the permission run on Ctrl+C while a permission dialog is open", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    client.emit({
      request: {
        choices: [
          { id: "allow_once", intent: "allow", label: "Allow once" },
          { id: "reject", intent: "deny", label: "Reject" },
        ],
        description: "tool:write",
        id: "permission_1",
        runId: "run_1",
        title: "Write file",
      },
      type: "permission.requested",
    });
    await flush();

    app.stdin.write("\u0003");
    await flush();

    expect(client.abortRun).toHaveBeenCalledWith("run_1");
  });

  it("executes exact slash commands but only completes on tab", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/res");
    app.stdin.write("\t");
    await waitForFrame(app, (frame) => frame.includes("/resume "));
    expect(client.executeCommand).not.toHaveBeenCalled();

    app.stdin.write("\u0015");
    app.stdin.write("/resume session_2");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["session_2"],
        commandId: "resume",
        path: ["resume"],
        sessionId: "session_1",
      }),
    );
  });

  it("executes the top-level /new session command from the backend catalog", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/new");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [],
        commandId: "new",
        path: ["new"],
        raw: "/new",
        sessionId: "session_1",
      }),
    );
  });

  it("shows slash candidates and executes a selected catalog command", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/");
    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("/models - Show current model") &&
        nextFrame.includes("/resume - Resume a session") &&
        nextFrame.includes("/sessions - Choose a session"),
    );

    expect(frame).toContain("/models - Show current model");
    expect(frame).toContain("/resume - Resume a session");
    expect(frame).toContain("/sessions - Choose a session");

    app.stdin.write("\u001B[B");
    await flush();
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "models",
        sessionId: "session_1",
      }),
    );
  });

  it("caps slash candidates and truncates long descriptions", async () => {
    const longDescription =
      "A very long command description that should not stretch the input area past a readable terminal width during dogfood sessions";
    const longCatalog: TuiCommandCatalog = {
      commands: Array.from({ length: 8 }, (_, index) => ({
        argumentMode: "argv" as const,
        category: "system",
        description: longDescription,
        id: `cmd.${String(index)}`,
        path: [`cmd${String(index)}`],
        source: "builtin" as const,
        surfaces: ["tui"],
      })),
      loadedAt: 1_771_000_000_000,
      surface: "tui",
      version: "long",
    };
    const client = createFakeClient(snapshot(), longCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("/cmd0"),
    );
    const hintLines = frame
      .split(/\r?\n/u)
      .filter((line) => line.includes("/cmd"));

    expect(hintLines).toHaveLength(6);
    expect(hintLines[0]?.trimStart()).toMatch(/^> \/cmd0/u);
    expect(hintLines[0]).toContain("...");
    expect(frame).not.toContain("/cmd6");
  });

  it("does not execute permission levels as slash subcommands", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/permission full-access");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain(
      'Unknown command "/permission full-access"',
    );
  });

  it("reloads the command catalog after invalidation events", async () => {
    const client = createFakeClient(snapshot(), catalog);
    render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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

  it("pages through session selections with PgUp and PgDn before resuming", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    client.emit({
      request: {
        commandRunId: "command_1",
        interactionId: "session_chooser",
        kind: "select-one",
        options: Array.from({ length: 12 }, (_, index) => ({
          id: `session_${String(index + 1)}`,
          label: `Session ${String(index + 1)}`,
        })),
        prompt: "Select session",
        subject: "session",
      },
      timestamp: 1,
      type: "interaction.requested",
    });
    await flush();

    app.stdin.write("\u001B[6~");
    await flush();
    app.stdin.write("\u001B[5~");
    await flush();
    app.stdin.write("\u001B[6~");
    await flush();
    app.stdin.write("\r");
    await flush();

    expect(client.respondInteraction).toHaveBeenCalledWith("session_chooser", {
      choiceId: "session_7",
      kind: "accepted",
    });
  });

  it("opens confirm interactions and sends confirmation responses", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

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
): TerminalClient & {
  readonly emit: (event: TuiEvent) => void;
  readonly abortRun: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly submitPrompt: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<TuiEventHandler>();

  return {
    abortRun: vi.fn(() => Promise.resolve()),
    compactSession: vi.fn(() =>
      Promise.resolve({
        sessionId: initialSnapshot.activeSessionId ?? "session_1",
        status: "not-needed" as const,
        usageAfter: {
          contextLimit: 100,
          currentTokens: 1,
          modelId: "fake-model",
          remainingTokens: 99,
          shouldCompress: false,
          usageRatio: 0.01,
        },
        usageBefore: {
          contextLimit: 100,
          currentTokens: 1,
          modelId: "fake-model",
          remainingTokens: 99,
          shouldCompress: false,
          usageRatio: 0.01,
        },
      }),
    ),
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

function command(
  input: Pick<TuiCommandSpec, "description" | "id" | "path"> &
    Partial<TuiCommandSpec>,
): TuiCommandSpec {
  return {
    argumentMode: "argv",
    category: "system",
    source: "builtin",
    surfaces: ["tui"],
    ...input,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForFrame(
  app: { readonly lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
  timeoutMs = 1_000,
): Promise<string> {
  const startedAt = Date.now();
  let frame = "";
  while (Date.now() - startedAt < timeoutMs) {
    await flush();
    frame = app.lastFrame() ?? "";
    if (predicate(frame)) {
      return frame;
    }
  }
  throw new Error(`Timed out waiting for frame. Last frame:\n${frame}`);
}

function lineIndex(frame: string | undefined, needle: string): number {
  return (frame ?? "")
    .split(/\r?\n/u)
    .findIndex((line) => line.includes(needle));
}
