import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiCommandInvocation,
  UiConnectModelResult,
  UiContextWindowUsage,
  UiEventHandler,
  UiSetSearchApiKeyResult,
  UiSnapshot,
} from "ohbaby-sdk";
import {
  NEW_SESSION_CLEAR_SEQUENCE,
  SESSION_VIEW_CLEAR_SEQUENCE,
} from "./app.js";
import { OhbabyTerminalApp } from "./index.js";
import { renderOhbabyLogo } from "./render/logo.js";
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

function contextWindowUsage(
  sessionId = "session_1",
  currentTokens = 38_400,
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

const catalog: TuiCommandCatalog = {
  commands: [
    command({
      description: "Show current model",
      id: "models",
      path: ["models"],
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
  version: "v1",
};

const displayCommandCatalog: TuiCommandCatalog = {
  commands: [
    command({
      description: "Show status",
      id: "status",
      path: ["status"],
    }),
    command({
      description: "List available commands",
      id: "help",
      path: ["help"],
    }),
    command({
      description: "Show current model",
      id: "models",
      path: ["models"],
    }),
    command({
      description: "List MCP server status",
      id: "mcps",
      path: ["mcps"],
    }),
    command({
      description: "List available skills",
      id: "skills",
      path: ["skills"],
    }),
    command({
      description: "Start a new session",
      id: "new",
      path: ["new"],
    }),
  ],
  version: "display",
};

const connectCommandCatalog: TuiCommandCatalog = {
  commands: [
    command({
      description: "Connect a model provider",
      id: "connect",
      path: ["connect"],
    }),
  ],
  version: "connect",
};

const connectSearchCommandCatalog: TuiCommandCatalog = {
  commands: [
    command({
      description: "Connect a search provider",
      id: "connect-search",
      path: ["connect-search"],
    }),
  ],
  version: "connect-search",
};

const previousNoAnimation = process.env.OHBABY_TUI_NO_ANIM;

beforeEach(() => {
  // Disable spinner/shimmer intervals: these content-level contract tests do not
  // assert animation, and leaked timers from un-unmounted running-state apps
  // otherwise pollute later tests.
  process.env.OHBABY_TUI_NO_ANIM = "1";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousNoAnimation === undefined) {
    delete process.env.OHBABY_TUI_NO_ANIM;
  } else {
    process.env.OHBABY_TUI_NO_ANIM = previousNoAnimation;
  }
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

    const logoAnchor = renderOhbabyLogo({ maxWidth: 80 })[0]?.trim();
    expect(app.lastFrame()).toContain("╭");
    expect(app.lastFrame()).toContain("╰");
    expect(app.lastFrame()).toContain(logoAnchor);
    expect(app.lastFrame()).not.toContain("___  _   _");
    expect(app.lastFrame()).toContain(">");
    expect(app.lastFrame()).not.toContain("▌");
    expect(app.lastFrame()).not.toContain("> message");
    expect(app.lastFrame()).not.toContain("ohbaby >");
    expect(app.lastFrame()).not.toContain("single-process coding agent");
    expect(app.lastFrame()).not.toContain("/ for commands");
  });

  it("renders typed prompt text without adding a cursor glyph to the buffer", async () => {
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

    expect(app.lastFrame()).toContain("> hello");
    expect(app.lastFrame()).not.toContain("▌");

    app.stdin.write("\u001B[H");
    await flush();

    expect(app.lastFrame()).toContain("> hello");
    expect(app.lastFrame()).not.toContain("▌");

    app.stdin.write("\u001B[F");
    await flush();

    expect(app.lastFrame()).toContain("> hello");
    expect(app.lastFrame()).not.toContain("▌");
    expect(app.lastFrame()).not.toContain("> hello |");
    expect(app.lastFrame()).not.toContain("ohbaby >");
  });

  it("treats terminal delete control fallbacks as editor deletion", async () => {
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
    app.stdin.write("\u001B[P");
    await flush();

    expect(app.lastFrame()).toContain("> hell");
    expect(app.lastFrame()).not.toContain("[P");
  });

  it("does not clear the transcript surface while editing the prompt or receiving runtime updates", async () => {
    const client = createFakeClient(snapshot());
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    const frameCount = app.stdout.frames.length;
    app.stdin.write("hello");
    await flush();
    app.stdin.write("\u001B[P");
    await flush();
    client.emit({
      status: { kind: "running", runId: "run_prompt_edit" },
      timestamp: Date.now(),
      type: "runtime.updated",
    });
    await flush();

    expect(app.lastFrame()).toContain("> hell");
    expect(app.stdout.frames.slice(frameCount).join("")).not.toContain(
      SESSION_VIEW_CLEAR_SEQUENCE,
    );
    app.unmount();
  });

  it("renders assistant markdown through the terminal markdown renderer", async () => {
    const baseSnapshot = snapshot();
    const client = createFakeClient({
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0],
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_markdown",
              parts: [{ text: "# Heading\n\n- **item**", type: "text" }],
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

    expect(app.lastFrame()).toContain("Heading");
    expect(app.lastFrame()).toContain("-------");
    expect(app.lastFrame()).toContain("- item");
    expect(app.lastFrame()).not.toContain("# Heading");
    expect(app.lastFrame()).not.toContain("**item**");
  });

  it("refreshes and renders active session context window usage", async () => {
    const usage = contextWindowUsage();
    const client = {
      ...createFakeClient(snapshot()),
      getContextWindowUsage: vi.fn(() => Promise.resolve(usage)),
    };
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    await waitForFrame(app, (frame) => frame.includes("38.4K / 1M (4%)"));

    expect(client.getContextWindowUsage).toHaveBeenCalledWith({
      sessionId: "session_1",
    });
  });

  it("keeps cached context window usage and emits a warning notice when refresh fails", async () => {
    const usage = contextWindowUsage();
    const client = {
      ...createFakeClient({
        ...snapshot(),
        contextWindowUsages: [usage],
      }),
      getContextWindowUsage: vi.fn(() =>
        Promise.reject(new Error("usage offline")),
      ),
    };
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("38.4K / 1M (4%)") &&
        nextFrame.includes("Context unavailable"),
    );

    expect(frame).toContain("offline");
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
    expect(app.lastFrame()).toContain("Hel");
    expect(app.lastFrame()).not.toContain("ohbaby");

    client.emit({
      delta: "lo",
      messageId: "message_1",
      sessionId: "session_1",
      type: "message.part.delta",
    });

    await waitForFrame(app, (frame) => frame.includes("Hello"));
  });

  it("renders historical user messages without a role label", async () => {
    const baseSnapshot = snapshot();
    const client = createFakeClient({
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0],
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_user",
              parts: [{ text: "please inspect the repo", type: "text" }],
              role: "user",
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

    expect(app.lastFrame()).toContain("| please inspect the repo");
    expect(app.lastFrame()).not.toContain("you");
  });

  it("folds reasoning from completed and legacy assistant messages only by message lifecycle", async () => {
    const baseSnapshot = snapshot();
    const client = createFakeClient({
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0],
          messages: [
            {
              completedAt: "2026-05-14T00:00:02.000Z",
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_completed",
              parts: [
                { text: "completed reasoning details", type: "reasoning" },
              ],
              role: "assistant",
              status: "completed",
            },
            {
              createdAt: "2026-05-14T00:00:03.000Z",
              id: "message_streaming",
              parts: [
                { text: "streaming reasoning details", type: "reasoning" },
              ],
              role: "assistant",
              status: "streaming",
            },
            {
              createdAt: "2026-05-14T00:00:04.000Z",
              id: "message_legacy",
              parts: [{ text: "legacy reasoning details", type: "reasoning" }],
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

    expect(app.lastFrame()).toContain("Thought");
    expect(app.lastFrame()).not.toContain("completed reasoning details");
    expect(app.lastFrame()).toContain("streaming reasoning details");
    expect(app.lastFrame()).not.toContain("legacy reasoning details");
  });

  it("renders live reasoning events and folds them before assistant text", async () => {
    const baseSnapshot = snapshot();
    const client = createFakeClient({
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0],
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_assistant",
              parts: [],
              role: "assistant",
              status: "streaming",
            },
          ],
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
    client.emit({
      content: "thinking through it",
      delta: "thinking through it",
      messageId: "message_assistant",
      sessionId: "session_1",
      type: "message.reasoning.delta",
    });
    await flush();

    expect(app.lastFrame()).toContain("thinking through it");

    client.emit({
      content: "thinking through it",
      messageId: "message_assistant",
      sessionId: "session_1",
      type: "message.reasoning.end",
    });
    await flush();

    expect(app.lastFrame()).toContain("Thought");
    expect(app.lastFrame()).not.toContain("thinking through it");

    client.emit({
      content: "Visible answer",
      delta: "Visible answer",
      messageId: "message_assistant",
      sessionId: "session_1",
      type: "message.part.delta",
    });
    await waitForFrame(app, (frame) => frame.includes("Visible answer"));

    expect(app.lastFrame()).toContain("Thought");
    expect(app.lastFrame()).toContain("Visible answer");

    client.emit({
      status: { kind: "idle" },
      timestamp: 2,
      type: "runtime.updated",
    });
    await waitForFrame(
      app,
      (frame) => frame.includes("Visible answer") && !frame.includes("Thought"),
    );
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

  it("renders command notices between committed transcript and live tail", async () => {
    const baseSnapshot = snapshot();
    const client = createFakeClient({
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0],
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_user",
              parts: [{ text: "committed prompt", type: "text" }],
              role: "user",
            },
            {
              createdAt: "2026-05-14T00:00:02.000Z",
              id: "message_live",
              parts: [{ text: "live answer", type: "text" }],
              role: "assistant",
              status: "streaming",
            },
          ],
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
    client.emit({
      clientInvocationId: "invoke_status",
      commandRunId: "command_status",
      output: { kind: "text", text: "command output" },
      timestamp: 1,
      type: "command.result.delivered",
    });
    await flush();

    const frame = app.lastFrame() ?? "";
    expect(frame.indexOf("committed prompt")).toBeLessThan(
      frame.indexOf("command output"),
    );
    expect(frame.indexOf("command output")).toBeLessThan(
      frame.indexOf("live answer"),
    );
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

    expect(app.lastFrame()).toContain("error: snapshot unavailable");
    expect(app.lastFrame()).not.toContain("status: error");
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

    expect(app.lastFrame()).toContain("error: command catalog unavailable");
    expect(app.lastFrame()).not.toContain("status: error");
  });

  it("renders permission state below the prompt and updates it from backend events", async () => {
    const client = createFakeClient({
      ...snapshot(),
      contextWindowUsages: [contextWindowUsage()],
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
    expect(app.lastFrame()).toContain("auto · default · session_1");
    expect(app.lastFrame()).toContain("38.4K / 1M (4%)");
    expect(app.lastFrame()).not.toContain("status: idle | session:");

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

    expect(app.lastFrame()).toContain("plan · full-access");
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
      content: "Hel",
      delta: "Hel",
      messageId: "message_assistant",
      sessionId: "session_stream",
      type: "message.part.delta",
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

    expect(app.lastFrame()).toContain("Hello");
    expect(app.lastFrame()).not.toContain("Hellolo");
    expect(app.lastFrame()).not.toContain("ohbaby");
    expect(app.lastFrame()).toContain("auto · default · session_stream");
    expect(app.lastFrame()).not.toContain("status: idle | session:");
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

    expect(app.lastFrame()).toContain("  Bash pwd");
    expect(app.lastFrame()).not.toContain("tool bash");
    expect(app.lastFrame()).not.toContain('input: {"command":"pwd"}');
    expect(app.lastFrame()).not.toContain("tool result");
    expect(app.lastFrame()).not.toContain("result hidden");
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

    expect(app.lastFrame()).toContain("  Web Search secret query");
    expect(app.lastFrame()).not.toContain("tool web_search");
    expect(app.lastFrame()).not.toContain("tool result");
    expect(app.lastFrame()).not.toContain("result hidden");
    expect(app.lastFrame()).not.toContain("Sensitive search body");
  });

  it("merges failed tool results into the tool call line", async () => {
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
              id: "message_failed_tool",
              parts: [
                {
                  call: {
                    id: "call_edit",
                    input: { file_path: "src/app.ts" },
                    name: "edit",
                    status: "failed",
                  },
                  type: "tool-call",
                },
                {
                  result: {
                    callId: "call_edit",
                    error: "permission denied",
                    output: "",
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

    expect(app.lastFrame()).toContain("  Edit src/app.ts permission denied");
    expect(app.lastFrame()).not.toContain("  Error permission denied");
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
    expect(app.lastFrame()).toContain("auto · default · session_1");
    expect(app.lastFrame()).not.toContain("status: running");
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

    expect(app.lastFrame()).toContain("Permission: Write file");
    expect(app.lastFrame()).not.toContain("status: waiting");
    expect(app.lastFrame()).not.toContain("permission_raw_123");
    expect(app.lastFrame()).toContain("Enter select");
    expect(app.lastFrame()).toContain("Esc safe default");
    expect(app.lastFrame()).toContain("> Allow once [allow]");
    expect(app.lastFrame()).toContain("  Reject [deny]");
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

  it("browses prompt history without losing the current draft", async () => {
    const client = createFakeClient(snapshot());
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

    app.stdin.write("draft");
    app.stdin.write("\u001B[A");
    await flush();
    expect(app.lastFrame()).toContain("> first");

    app.stdin.write("\u001B[B");
    await flush();
    expect(app.lastFrame()).toContain("> draft");
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

  it("shows queued state for prompts submitted while a run is active", async () => {
    const queuedSubmit = createDeferred<undefined>();
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
    client.submitPrompt.mockReturnValueOnce(queuedSubmit.promise);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("follow up");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Queued"));

    expect(client.submitPrompt).toHaveBeenCalledWith("follow up", {
      sessionId: "session_1",
    });
    expect(app.lastFrame()).not.toContain("follow up");

    queuedSubmit.resolve(undefined);
    await waitForFrame(app, (frame) => !frame.includes("Queued"));
  });

  it("shows queued state for a rapid second prompt before runtime events arrive", async () => {
    const firstSubmit = createDeferred<undefined>();
    const secondSubmit = createDeferred<undefined>();
    const client = createFakeClient(snapshot());
    client.submitPrompt
      .mockReturnValueOnce(firstSubmit.promise)
      .mockReturnValueOnce(secondSubmit.promise);
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

    app.stdin.write("second");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Queued"));

    expect(client.submitPrompt).toHaveBeenCalledWith("second", {
      sessionId: "session_1",
    });

    firstSubmit.resolve(undefined);
    secondSubmit.resolve(undefined);
    await waitForFrame(app, (frame) => !frame.includes("Queued"));
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

  it("aborts the active run on double Esc when no dialog is open", async () => {
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
    app.stdin.write("\u001B");
    await waitForFrame(app, (frame) =>
      frame.includes("Press Esc again to interrupt"),
    );

    app.stdin.write("\u001B");
    await flush();

    expect(client.abortRun).toHaveBeenCalledWith("run_1");
  });

  it("requires a fresh double Esc after the active run changes", async () => {
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
    app.stdin.write("\u001B");
    await waitForFrame(app, (frame) =>
      frame.includes("Press Esc again to interrupt"),
    );

    client.emit({
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "idle" },
        updatedAt: "2026-05-14T00:00:04.000Z",
      },
      type: "run.updated",
    });
    await flush();
    client.emit({
      run: {
        id: "run_2",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:05.000Z",
        status: { kind: "running", runId: "run_2" },
        updatedAt: "2026-05-14T00:00:05.000Z",
      },
      type: "run.updated",
    });
    await waitForFrame(
      app,
      (frame) => !frame.includes("Press Esc again to interrupt"),
    );

    app.stdin.write("\u001B");
    await waitForFrame(app, (frame) =>
      frame.includes("Press Esc again to interrupt"),
    );

    expect(client.abortRun).not.toHaveBeenCalled();

    app.stdin.write("\u001B");
    await flush();

    expect(client.abortRun).toHaveBeenCalledWith("run_2");
  });

  it("disarms Esc interruption while a permission dialog is open", async () => {
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
    app.stdin.write("\u001B");
    await waitForFrame(app, (frame) =>
      frame.includes("Press Esc again to interrupt"),
    );

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
    client.emit({
      requestId: "permission_1",
      type: "permission.resolved",
    });
    await waitForFrame(
      app,
      (frame) => !frame.includes("Press Esc again to interrupt"),
    );

    app.stdin.write("\u001B");
    await waitForFrame(app, (frame) =>
      frame.includes("Press Esc again to interrupt"),
    );

    expect(client.abortRun).not.toHaveBeenCalled();

    app.stdin.write("\u001B");
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
    app.stdin.write("/ses");
    app.stdin.write("\t");
    await waitForFrame(app, (frame) => frame.includes("/sessions "));
    expect(client.executeCommand).not.toHaveBeenCalled();

    app.stdin.write("\u0015");
    app.stdin.write("/sessions");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [],
        commandId: "sessions",
        path: ["sessions"],
        sessionId: "session_1",
      }),
    );
  });

  it("does not execute the removed /resume slash command", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/resume session_2");
    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('Unknown command "/resume session_2"');
  });

  it("tab completes the highlighted slash candidate without executing it", async () => {
    const commandCatalog: TuiCommandCatalog = {
      commands: [
        command({
          description: "Start a new session",
          id: "new",
          path: ["new"],
        }),
        command({
          description: "Use this skill whenever the user wants PDFs",
          id: "skill.pdf",
          path: ["pdf"],
        }),
        command({
          description: "Exit the current UI surface",
          id: "exit",
          path: ["exit"],
        }),
        command({
          description: "List available commands",
          id: "help",
          path: ["help"],
        }),
        command({
          description: "List MCP server status",
          id: "mcps",
          path: ["mcps"],
        }),
      ],
      version: "slash-tab",
    };
    const client = createFakeClient(snapshot(), commandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/");
    await waitForFrame(
      app,
      (frame) =>
        frame.includes("/new - Start a new session") &&
        frame.includes("/mcps - List MCP server status"),
    );

    for (let index = 0; index < 4; index += 1) {
      app.stdin.write("\u001B[B");
      await flush();
    }
    expect(app.lastFrame()).toContain("> /mcps - List MCP server status");

    app.stdin.write("\t");
    await waitForFrame(app, (frame) => frame.includes("> /mcps "));

    expect(client.executeCommand).not.toHaveBeenCalled();

    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [],
        commandId: "mcps",
        path: ["mcps"],
        raw: "/mcps",
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

  it("clears screen and scrollback when /new selects a session", async () => {
    const client = createFakeClient(snapshot(), catalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2", source: "new" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_new",
      commandRunId: "command_new",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();

    expect(app.stdout.frames.slice(frameCount).join("")).toContain(
      NEW_SESSION_CLEAR_SEQUENCE,
    );
    app.unmount();
  });

  it("clears screen once before rendering a fresh startup frame", async () => {
    const client = createFakeClient({
      activeSessionId: null,
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    });
    const startupProps = {
      clearOnStart: true,
      client,
      subscribeEvents: client.subscribeEvents,
    };
    const app = render(<OhbabyTerminalApp {...startupProps} />);

    await flush();

    const clearFrames = app.stdout.frames.filter((frame) =>
      frame.includes(NEW_SESSION_CLEAR_SEQUENCE),
    );
    expect(clearFrames).toHaveLength(1);
    expect(app.stdout.frames.join("").indexOf(NEW_SESSION_CLEAR_SEQUENCE)).toBe(
      0,
    );
    expect(app.lastFrame()).toContain(">");
    app.rerender(<OhbabyTerminalApp {...startupProps} />);
    await flush();
    expect(
      app.stdout.frames.filter((frame) =>
        frame.includes(NEW_SESSION_CLEAR_SEQUENCE),
      ),
    ).toHaveLength(1);
    app.unmount();
  });

  it("repaints the current empty frame when /new reuses the active session", async () => {
    const client = createFakeClient({
      activeSessionId: "session_empty",
      permissions: [],
      runs: [],
      sessions: [
        {
          createdAt: "2026-05-14T00:00:00.000Z",
          id: "session_empty",
          messages: [],
          projectRoot: "D:/Projects/app",
          title: "New session",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      status: { kind: "idle" },
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    expect(app.lastFrame()).toContain(">");
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_empty", source: "new" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_new",
      commandRunId: "command_new",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();

    const output = app.stdout.frames.slice(frameCount).join("");
    const clearIndex = output.indexOf(NEW_SESSION_CLEAR_SEQUENCE);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(
      output.slice(clearIndex + NEW_SESSION_CLEAR_SEQUENCE.length),
    ).toContain(">");
    app.unmount();
  });

  it("clears the transcript surface after an existing session snapshot is confirmed", async () => {
    const currentSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:00.000Z",
      id: "session_1",
      messages: [
        {
          createdAt: "2026-05-14T00:00:01.000Z",
          id: "message_1",
          parts: [{ text: "Source history before switch", type: "text" }],
          role: "assistant",
        },
      ],
      title: "Source",
      updatedAt: "2026-05-14T00:00:02.000Z",
    };
    const targetSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "session_2",
      messages: [
        {
          createdAt: "2026-05-14T00:00:04.000Z",
          id: "message_2",
          parts: [{ text: "Target history after switch", type: "text" }],
          role: "assistant",
        },
      ],
      title: "Target",
      updatedAt: "2026-05-14T00:00:05.000Z",
    };
    const initialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [currentSession, { ...targetSession, messages: [] }],
    };
    const refreshedSnapshot: UiSnapshot = {
      ...initialSnapshot,
      activeSessionId: "session_2",
      sessions: [{ ...currentSession, messages: [] }, targetSession],
    };
    const refresh = createDeferred<UiSnapshot>();
    const client = createFakeClient(initialSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockReturnValueOnce(refresh.promise);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) =>
      frame.includes("Source history before switch"),
    );
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_resume",
      commandRunId: "command_resume",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();

    expect(app.stdout.frames.slice(frameCount).join("")).not.toContain(
      SESSION_VIEW_CLEAR_SEQUENCE,
    );
    refresh.resolve(refreshedSnapshot);
    await waitForFrame(app, (frame) =>
      frame.includes("Target history after switch"),
    );

    const output = app.stdout.frames.slice(frameCount).join("");
    expect(countOccurrences(output, SESSION_VIEW_CLEAR_SEQUENCE)).toBe(1);
    const clearIndex = output.lastIndexOf(SESSION_VIEW_CLEAR_SEQUENCE);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    const afterClear = output.slice(
      clearIndex + SESSION_VIEW_CLEAR_SEQUENCE.length,
    );
    expect(afterClear).toContain("Target history after switch");
    expect(afterClear).not.toContain("Source history before switch");
    expect(afterClear).not.toContain(renderOhbabyLogo());
    app.unmount();
  });

  it("keeps the current transcript surface when an existing session refresh fails", async () => {
    const currentSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:00.000Z",
      id: "session_1",
      messages: [
        {
          createdAt: "2026-05-14T00:00:01.000Z",
          id: "message_1",
          parts: [
            { text: "Source history before failed switch", type: "text" },
          ],
          role: "assistant",
        },
      ],
      title: "Source",
      updatedAt: "2026-05-14T00:00:02.000Z",
    };
    const targetSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "session_2",
      messages: [],
      title: "Target",
      updatedAt: "2026-05-14T00:00:04.000Z",
    };
    const initialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [currentSession, targetSession],
    };
    const client = createFakeClient(initialSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockRejectedValueOnce(new Error("snapshot refresh failed"));
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) =>
      frame.includes("Source history before failed switch"),
    );
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions",
      commandRunId: "command_sessions",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();

    expect(app.stdout.frames.slice(frameCount).join("")).not.toContain(
      SESSION_VIEW_CLEAR_SEQUENCE,
    );
    expect(app.lastFrame()).toContain("Source history before failed switch");
    expect(app.lastFrame()).toContain("auto · default · session_1");
    expect(app.lastFrame()).not.toContain(renderOhbabyLogo());
    app.unmount();
  });

  it("keeps the current transcript surface when an existing session refresh returns a mismatched active session", async () => {
    const currentSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:00.000Z",
      id: "session_1",
      messages: [
        {
          createdAt: "2026-05-14T00:00:01.000Z",
          id: "message_1",
          parts: [
            {
              text: "Source history before mismatched switch",
              type: "text",
            },
          ],
          role: "assistant",
        },
      ],
      title: "Source",
      updatedAt: "2026-05-14T00:00:02.000Z",
    };
    const targetSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "session_2",
      messages: [
        {
          createdAt: "2026-05-14T00:00:04.000Z",
          id: "message_2",
          parts: [{ text: "Mismatched target history", type: "text" }],
          role: "assistant",
        },
      ],
      title: "Target",
      updatedAt: "2026-05-14T00:00:05.000Z",
    };
    const initialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [currentSession, { ...targetSession, messages: [] }],
    };
    const mismatchedSnapshot: UiSnapshot = {
      ...initialSnapshot,
      activeSessionId: "session_1",
      sessions: [currentSession, targetSession],
    };
    const client = createFakeClient(initialSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(mismatchedSnapshot);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) =>
      frame.includes("Source history before mismatched switch"),
    );
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions_mismatch",
      commandRunId: "command_sessions_mismatch",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();

    const output = app.stdout.frames.slice(frameCount).join("");
    expect(output).not.toContain(SESSION_VIEW_CLEAR_SEQUENCE);
    expect(app.lastFrame()).toContain(
      "Source history before mismatched switch",
    );
    expect(app.lastFrame()).toContain("auto · default · session_1");
    expect(app.lastFrame()).not.toContain("Mismatched target history");
    expect(app.lastFrame()).not.toContain(renderOhbabyLogo());
    app.unmount();
  });

  it("refreshes the selected existing session snapshot after session selection", async () => {
    const currentSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:00.000Z",
      id: "session_1",
      messages: [
        {
          createdAt: "2026-05-14T00:00:01.000Z",
          id: "message_1",
          parts: [{ text: "Main history", type: "text" }],
          role: "assistant",
        },
      ],
      title: "Main",
      updatedAt: "2026-05-14T00:00:02.000Z",
    };
    const targetSession: UiSnapshot["sessions"][number] = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "session_2",
      messages: [],
      title: "Target",
      updatedAt: "2026-05-14T00:00:04.000Z",
    };
    const staleFilteredSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [currentSession, targetSession],
    };
    const refreshedSnapshot: UiSnapshot = {
      ...staleFilteredSnapshot,
      activeSessionId: "session_2",
      sessions: [
        {
          ...currentSession,
          messages: [],
        },
        {
          ...targetSession,
          messages: [
            {
              createdAt: "2026-05-14T00:00:05.000Z",
              id: "message_2",
              parts: [{ text: "Restored target history", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    };
    const client = createFakeClient(staleFilteredSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(staleFilteredSnapshot)
      .mockResolvedValueOnce(refreshedSnapshot);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) => frame.includes("Main history"));
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions",
      commandRunId: "command_sessions",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });

    const frame = await waitForFrame(app, (candidate) =>
      candidate.includes("Restored target history"),
    );
    expect(frame).not.toContain(renderOhbabyLogo());
    expect(client.getSnapshot).toHaveBeenCalledTimes(2);
    const output = app.stdout.frames.slice(frameCount).join("");
    expect(countOccurrences(output, SESSION_VIEW_CLEAR_SEQUENCE)).toBe(1);
    const clearIndex = output.lastIndexOf(SESSION_VIEW_CLEAR_SEQUENCE);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    const afterClear = output.slice(
      clearIndex + SESSION_VIEW_CLEAR_SEQUENCE.length,
    );
    expect(afterClear).toContain("Restored target history");
    expect(afterClear).not.toContain("Main history");
    expect(afterClear).not.toContain(renderOhbabyLogo());
    app.unmount();
  });

  it("ignores a stale initial snapshot after an existing session refresh wins", async () => {
    const staleInitialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [
        {
          createdAt: "2026-05-14T00:00:00.000Z",
          id: "session_1",
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_1",
              parts: [{ text: "Stale initial history", type: "text" }],
              role: "assistant",
            },
          ],
          title: "Main",
          updatedAt: "2026-05-14T00:00:02.000Z",
        },
        {
          createdAt: "2026-05-14T00:00:03.000Z",
          id: "session_2",
          messages: [],
          title: "Target",
          updatedAt: "2026-05-14T00:00:04.000Z",
        },
      ],
    };
    const refreshedSnapshot: UiSnapshot = {
      ...staleInitialSnapshot,
      activeSessionId: "session_2",
      sessions: [
        {
          ...staleInitialSnapshot.sessions[0],
          messages: [],
        },
        {
          ...staleInitialSnapshot.sessions[1],
          messages: [
            {
              createdAt: "2026-05-14T00:00:05.000Z",
              id: "message_2",
              parts: [{ text: "Fresh selected history", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    };
    const initial = createDeferred<UiSnapshot>();
    const refresh = createDeferred<UiSnapshot>();
    const client = createFakeClient(staleInitialSnapshot, catalog);
    client.getSnapshot
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions",
      commandRunId: "command_sessions",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    refresh.resolve(refreshedSnapshot);
    const selectedFrame = await waitForFrame(app, (candidate) =>
      candidate.includes("Fresh selected history"),
    );
    expect(selectedFrame).not.toContain("Stale initial history");

    initial.resolve(staleInitialSnapshot);
    await flush();
    expect(app.lastFrame()).toContain("Fresh selected history");
    expect(app.lastFrame()).not.toContain("Stale initial history");
    app.unmount();
  });

  it("keeps the latest selected session when refreshes resolve out of order", async () => {
    const sessionOne = {
      createdAt: "2026-05-14T00:00:00.000Z",
      id: "session_1",
      messages: [
        {
          createdAt: "2026-05-14T00:00:01.000Z",
          id: "message_1",
          parts: [{ text: "Original history", type: "text" }],
          role: "assistant",
        },
      ],
      title: "One",
      updatedAt: "2026-05-14T00:00:02.000Z",
    } satisfies UiSnapshot["sessions"][number];
    const sessionTwo = {
      createdAt: "2026-05-14T00:00:03.000Z",
      id: "session_2",
      messages: [],
      title: "Two",
      updatedAt: "2026-05-14T00:00:04.000Z",
    } satisfies UiSnapshot["sessions"][number];
    const sessionThree = {
      createdAt: "2026-05-14T00:00:05.000Z",
      id: "session_3",
      messages: [],
      title: "Three",
      updatedAt: "2026-05-14T00:00:06.000Z",
    } satisfies UiSnapshot["sessions"][number];
    const initialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [sessionOne, sessionTwo, sessionThree],
    };
    const secondSelection = createDeferred<UiSnapshot>();
    const thirdSelection = createDeferred<UiSnapshot>();
    const client = createFakeClient(initialSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockReturnValueOnce(secondSelection.promise)
      .mockReturnValueOnce(thirdSelection.promise);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) => frame.includes("Original history"));
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions_2",
      commandRunId: "command_sessions_2",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    client.emit({
      action: {
        data: { choiceId: "session_3" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions_3",
      commandRunId: "command_sessions_3",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    thirdSelection.resolve({
      ...initialSnapshot,
      activeSessionId: "session_3",
      sessions: [
        { ...sessionOne, messages: [] },
        { ...sessionTwo, messages: [] },
        {
          ...sessionThree,
          messages: [
            {
              createdAt: "2026-05-14T00:00:07.000Z",
              id: "message_3",
              parts: [{ text: "Latest selected history", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    });
    await waitForFrame(app, (frame) =>
      frame.includes("Latest selected history"),
    );

    secondSelection.resolve({
      ...initialSnapshot,
      activeSessionId: "session_2",
      sessions: [
        { ...sessionOne, messages: [] },
        {
          ...sessionTwo,
          messages: [
            {
              createdAt: "2026-05-14T00:00:08.000Z",
              id: "message_2",
              parts: [{ text: "Older selected history", type: "text" }],
              role: "assistant",
            },
          ],
        },
        { ...sessionThree, messages: [] },
      ],
    });
    await flush();
    expect(app.lastFrame()).toContain("Latest selected history");
    expect(app.lastFrame()).not.toContain("Older selected history");
    app.unmount();
  });

  it("does not let a pending existing-session refresh override /new", async () => {
    const initialSnapshot: UiSnapshot = {
      ...snapshot(),
      activeSessionId: "session_1",
      sessions: [
        {
          createdAt: "2026-05-14T00:00:00.000Z",
          id: "session_1",
          messages: [
            {
              createdAt: "2026-05-14T00:00:01.000Z",
              id: "message_1",
              parts: [{ text: "Original history", type: "text" }],
              role: "assistant",
            },
          ],
          title: "One",
          updatedAt: "2026-05-14T00:00:02.000Z",
        },
        {
          createdAt: "2026-05-14T00:00:03.000Z",
          id: "session_2",
          messages: [],
          title: "Two",
          updatedAt: "2026-05-14T00:00:04.000Z",
        },
      ],
    };
    const oldRefresh = createDeferred<UiSnapshot>();
    const client = createFakeClient(initialSnapshot, catalog);
    client.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockReturnValueOnce(oldRefresh.promise);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) => frame.includes("Original history"));
    const frameCount = app.stdout.frames.length;
    client.emit({
      action: {
        data: { choiceId: "session_2" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_sessions",
      commandRunId: "command_sessions",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    client.emit({
      action: {
        data: { choiceId: "session_new", source: "new" },
        kind: "session.selected",
      },
      clientInvocationId: "inv_new",
      commandRunId: "command_new",
      timestamp: Date.now(),
      type: "command.result.delivered",
    });
    await flush();
    expect(app.stdout.frames.slice(frameCount).join("")).toContain(
      NEW_SESSION_CLEAR_SEQUENCE,
    );

    oldRefresh.resolve({
      ...initialSnapshot,
      activeSessionId: "session_2",
      sessions: [
        {
          ...initialSnapshot.sessions[0],
          messages: [],
        },
        {
          ...initialSnapshot.sessions[1],
          messages: [
            {
              createdAt: "2026-05-14T00:00:05.000Z",
              id: "message_2",
              parts: [{ text: "Old refresh history", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    });
    await flush();
    expect(app.lastFrame()).not.toContain("Old refresh history");
    expect(client.getSnapshot).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("routes /status result into an overlay card that closes with Escape", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await flush();

    const invocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_status",
      output: {
        data: {
          contextWindow: contextWindowUsage(),
          mcps: {
            connected: 2,
            disabled: 0,
            disconnected: 0,
            failed: 0,
            total: 2,
          },
          model: {
            id: "glm-5.1",
            label: "GLM 5.1",
            provider: "zhipu",
          },
          permission: {
            level: "default",
            mode: "auto",
            sessionRules: [],
          },
          projectRoot: "D:/Projects/Code-cli/ohbaby-agent",
          sessionId: "session_1",
          status: "idle",
          tools: { builtin: 16, mcp: 45, module: 0, skill: 2 },
        },
        kind: "data",
        subject: "status",
      },
      timestamp: 1,
      type: "command.result.delivered",
    });

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Status") &&
        nextFrame.includes("esc") &&
        nextFrame.includes("Runtime") &&
        nextFrame.includes("idle"),
    );
    expect(frame).toContain("38.4K / 1M (4%)");

    app.stdin.write("\u001B");
    await waitForFrame(
      app,
      (nextFrame) =>
        !nextFrame.includes("Runtime") && !nextFrame.includes("Project"),
    );
  });

  it("swallows a late display command result after its overlay has been closed", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);

    const invocation = firstExecutedCommand(client);
    await waitForFrame(app, (nextFrame) => nextFrame.includes("Loading..."));
    app.stdin.write("\u001B");
    await waitForFrame(app, (nextFrame) => !nextFrame.includes("Loading..."));

    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_status_late",
      output: {
        data: {
          projectRoot: "D:/Projects/Code-cli/ohbaby-agent",
          sessionId: "session_1",
          status: "idle",
        },
        kind: "data",
        subject: "status",
      },
      timestamp: 2,
      type: "command.result.delivered",
    });
    await flush();

    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("Runtime");
    expect(frame).not.toContain("command_status_late");
    expect(frame).not.toContain("Project");
  });

  it("routes display command failures into an overlay without leaking connection secrets", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/models");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);

    const invocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_models_failed",
      error: {
        code: "MODEL_CONFIG_FAILED",
        message:
          "Failed https://proxy.example/v1?api_key=do-not-print with Bearer secret-token and OPENAI_API_KEY sk-ai-v1-secret",
        recoverable: true,
      },
      timestamp: 3,
      type: "command.failed",
    });

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Models") && nextFrame.includes("Failed"),
    );
    expect(frame).not.toContain("proxy.example");
    expect(frame).not.toContain("do-not-print");
    expect(frame).not.toContain("secret-token");
    expect(frame).not.toContain("OPENAI_API_KEY");
    expect(frame).not.toContain("sk-ai-v1-secret");
    expect(frame).not.toContain("command_models_failed");
  });

  it("swallows a late display command failure after its overlay has been closed", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);

    const invocation = firstExecutedCommand(client);
    await waitForFrame(app, (nextFrame) => nextFrame.includes("Loading..."));
    app.stdin.write("\u001B");
    await waitForFrame(app, (nextFrame) => !nextFrame.includes("Loading..."));

    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_status_late_failed",
      error: {
        code: "STATUS_FAILED",
        message: "late display failure should not render",
        recoverable: true,
      },
      timestamp: 4,
      type: "command.failed",
    });
    await flush();

    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("late display failure");
    expect(frame).not.toContain("STATUS_FAILED");
  });

  it("closes a display command overlay when the active session changes", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await waitForFrame(app, (nextFrame) => nextFrame.includes("Loading..."));

    client.emit({
      snapshot: {
        activeSessionId: "session_2",
        permissions: [],
        runs: [],
        sessions: [
          {
            createdAt: "2026-05-14T00:00:00.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:01.000Z",
          },
        ],
        status: { kind: "idle" },
      },
      timestamp: 2,
      type: "snapshot.replaced",
    });

    await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("session_2") &&
        !nextFrame.includes("Loading...") &&
        !nextFrame.includes("Status"),
    );
  });

  it("swallows a same-tick stale display result after active session replacement", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);
    const invocation = firstExecutedCommand(client);

    client.emit({
      snapshot: {
        activeSessionId: "session_2",
        permissions: [],
        runs: [],
        sessions: [
          {
            createdAt: "2026-05-14T00:00:00.000Z",
            id: "session_2",
            messages: [],
            title: "Second",
            updatedAt: "2026-05-14T00:00:01.000Z",
          },
        ],
        status: { kind: "idle" },
      },
      timestamp: 5,
      type: "snapshot.replaced",
    });
    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_status_stale",
      output: {
        data: {
          projectRoot: "D:/Stale",
          sessionId: "session_1",
          status: "idle",
        },
        kind: "data",
        subject: "status",
      },
      timestamp: 6,
      type: "command.result.delivered",
    });

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("session_2") &&
        !nextFrame.includes("D:/Stale") &&
        !nextFrame.includes("Status"),
    );
    expect(frame).not.toContain("Runtime");
  });

  it("keeps app-level shortcuts inactive while a display overlay is open", async () => {
    const client = createFakeClient(
      {
        ...snapshot(),
        permission: {
          level: "default",
          mode: "auto",
          sessionRules: [],
        },
      },
      displayCommandCatalog,
    );
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/status");
    app.stdin.write("\r");
    await waitForFrame(app, (nextFrame) => nextFrame.includes("Loading..."));
    const callsAfterStatus = client.executeCommand.mock.calls.length;

    app.stdin.write("\u001B[Z");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledTimes(callsAfterStatus);
    expect(app.lastFrame()).toContain("Loading...");
  });

  it("opens /connect as a local form without executing a slash command", async () => {
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/connect");
    app.stdin.write("\r");

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Connect") && nextFrame.includes("Provider"),
    );

    expect(frame).toContain("Base URL");
    expect(client.executeCommand).not.toHaveBeenCalled();
    expect(client.connectModel).not.toHaveBeenCalled();
    app.unmount();
  });

  it("opens /connect-search as a local form without executing a slash command", async () => {
    const client = createFakeClient(snapshot(), connectSearchCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectSearchForm(app);
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Connect Search");
    expect(frame).toContain("API key env");
    expect(frame).toContain("API key value");
    expect(client.executeCommand).not.toHaveBeenCalled();
    expect(client.setSearchApiKey).not.toHaveBeenCalled();
    app.unmount();
  });

  it("auto-saves /connect-search after key commit and keeps the API key masked", async () => {
    const client = createFakeClient(snapshot(), connectSearchCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectSearchForm(app);
    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "tvly-search-secret");
    const secretFrame = app.lastFrame() ?? "";
    expect(secretFrame).not.toContain("tvly-search-secret");
    expect(secretFrame).toContain("******************");

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("saved"),
    );

    expect(client.setSearchApiKey).toHaveBeenCalledTimes(1);
    expect(client.setSearchApiKey).toHaveBeenCalledWith({
      apiKey: "tvly-search-secret",
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
    expect(frame).not.toContain("tvly-search-secret");
    app.unmount();
  });

  it("prefills /connect from the current saved model on a single page", async () => {
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    client.getCurrentModel.mockResolvedValue({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      contextWindowTokens: 128_000,
      interfaceProvider: "anthropic",
      maxOutputTokens: 8192,
      model: "glm-5.1",
      provider: "zenmux",
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("zenmux") &&
        nextFrame.includes("glm-5.1") &&
        nextFrame.includes("Context window"),
    );

    expect(frame).not.toContain("Connection 1/2");
    expect(frame).not.toContain("pgup/pgdn");
    expect(frame).not.toContain("Interface");
    expect(frame).toContain("Base URL");
    expect(frame).toContain("https://zenmux.ai/api/anthropic");
    expect(frame).toContain("API key env");
    expect(frame).toContain("ZENMUX_API_KEY");
    expect(frame).toContain("API key value");
    expect(frame).toMatch(/Model name\s+glm-5\.1/u);
    expect(frame).toContain("Context window");
    expect(frame).toContain("optional 128000");
    expect(frame).toContain("Max output tokens");
    expect(frame).toContain("optional 8192");
    expect(client.connectModel).not.toHaveBeenCalled();
    app.unmount();
  });

  it("auto-saves /connect after field commits and keeps the API key masked", async () => {
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    await submitConnectField(app, "zenmux");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "https://zenmux.ai/api/anthropic");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "ZENMUX_API_KEY");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "sk-connect-secret");
    const secretFrame = app.lastFrame() ?? "";
    expect(secretFrame).not.toContain("sk-connect-secret");
    expect(secretFrame).toContain("********");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "anthropic/claude-sonnet-4.6");

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("saved"),
    );

    expect(client.connectModel).toHaveBeenCalledTimes(1);
    expect(client.connectModel).toHaveBeenCalledWith({
      apiKey: "sk-connect-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      provider: "zenmux",
    });
    expect(frame).not.toContain("sk-connect-secret");
    app.unmount();
  });

  it("shows a lightweight /connect probe warning after save", async () => {
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    client.connectModel.mockResolvedValue(
      connectResult({
        warning:
          "Unable to detect model context window from metadata; using the configured fallback.",
      }),
    );
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    await submitConnectField(app, "zenmux");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "https://zenmux.ai/api/anthropic");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "ZENMUX_API_KEY");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "sk-connect-secret");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "anthropic/claude-sonnet-4.6");

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("saved - Unable to detect model context window"),
    );

    expect(frame).not.toContain("contextWindowSource");
    expect(frame).not.toContain("sk-connect-secret");
    app.unmount();
  });

  it("updates the /connect API key mask while typing and deleting", async () => {
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\r");
    await sendConnectKey(app, "s");
    expect(app.lastFrame() ?? "").toMatch(/API key value\s+\*/u);
    await sendConnectKey(app, "k");
    expect(app.lastFrame() ?? "").toMatch(/API key value\s+\*{2}/u);
    await sendConnectKey(app, "1");

    const typedFrame = app.lastFrame() ?? "";
    expect(typedFrame).toMatch(/API key value\s+\*{3}/u);
    expect(typedFrame).not.toContain("sk1");

    await sendConnectKey(app, "\b");
    const deletedFrame = app.lastFrame() ?? "";
    expect(deletedFrame).toMatch(/API key value\s+\*{2}/u);
    expect(deletedFrame).not.toMatch(/API key value\s+\*{3}/u);
    expect(deletedFrame).not.toContain("sk");
    app.unmount();
  });

  it("does not save /connect while runtime status is running", async () => {
    const client = createFakeClient(
      {
        ...snapshot(),
        status: { kind: "running", runId: "run_1", title: "Working" },
      },
      connectCommandCatalog,
    );
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    await submitConnectField(app, "zenmux");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "https://zenmux.example/v1");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "ZENMUX_API_KEY");
    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "anthropic/claude-sonnet-4.6");
    await flush();

    expect(client.connectModel).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain("running");
    app.unmount();
  });

  it("queues /connect auto-saves so the latest committed payload wins", async () => {
    const firstSave = createDeferred<UiConnectModelResult>();
    const secondSave = createDeferred<UiConnectModelResult>();
    let saveCount = 0;
    const client = createFakeClient(snapshot(), connectCommandCatalog);
    client.connectModel.mockImplementation(() => {
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : secondSave.promise;
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await openConnectForm(app);
    await submitConnectField(app, "zenmux");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "https://zenmux.example/v1");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "ZENMUX_API_KEY");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "sk-connect-secret");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "anthropic/claude-sonnet-4.6");
    await waitForConnectModelCount(client, 1);

    await sendConnectKey(app, "\u001B[B");
    await sendConnectKey(app, "\u001B[B");
    await submitConnectField(app, "4096");
    await settleConnectInput();
    expect(client.connectModel).toHaveBeenCalledTimes(1);

    firstSave.resolve(connectResult());
    await waitForConnectModelCount(client, 2);
    expect(client.connectModel.mock.calls[1]?.[0]).toMatchObject({
      maxOutputTokens: 4096,
      model: "anthropic/claude-sonnet-4.6",
    });

    secondSave.resolve(connectResult({ maxOutputTokens: 4096 }));
    await waitForFrame(app, (nextFrame) => nextFrame.includes("saved"));
    expect(client.connectModel).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("routes /help into an overlay card instead of a persistent command notice", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/help");
    app.stdin.write("\r");
    await flush();

    const helpInvocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: helpInvocation.clientInvocationId,
      commandRunId: "command_help",
      output: {
        data: {
          commands: displayCommandCatalog.commands,
        },
        kind: "data",
        subject: "help",
      },
      timestamp: 1,
      type: "command.result.delivered",
    });

    const helpFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Help") &&
        nextFrame.includes("esc") &&
        nextFrame.includes("/models"),
    );
    expect(helpFrame).toContain("/mcps");
    expect(helpFrame).not.toContain("System");

    app.stdin.write("\u001B");
    await waitForFrame(app, (nextFrame) => !nextFrame.includes("/models"));
  });

  it("routes /mcps into an overlay card instead of a persistent command notice", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/mcps");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);

    const mcpsInvocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: mcpsInvocation.clientInvocationId,
      commandRunId: "command_mcps",
      output: {
        data: {
          servers: [
            { name: "firecrawl", status: "connected" },
            { name: "playwright", status: "connected" },
          ],
        },
        kind: "data",
        subject: "mcps",
      },
      timestamp: 2,
      type: "command.result.delivered",
    });

    const mcpsFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("MCP") &&
        nextFrame.includes("firecrawl") &&
        nextFrame.includes("connected"),
    );
    expect(mcpsFrame).toContain("esc");

    app.stdin.write("\u001B");
    await waitForFrame(app, (nextFrame) => !nextFrame.includes("firecrawl"));
  });

  it("routes /skills into a selectable overlay card instead of a persistent command notice", async () => {
    const client = createFakeClient(snapshot(), displayCommandCatalog);
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/skills");
    app.stdin.write("\r");
    await waitForCommandCount(client, 1);

    const skills = Array.from({ length: 12 }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, "0");
      return {
        description: `Description ${ordinal}`,
        name: `skill-${ordinal}`,
        scope: index % 2 === 0 ? "user" : "project",
        source: "project-native",
      };
    });
    const skillsInvocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: skillsInvocation.clientInvocationId,
      commandRunId: "command_skills",
      output: {
        data: {
          skills,
        },
        kind: "data",
        subject: "skills",
      },
      timestamp: 3,
      type: "command.result.delivered",
    });

    const firstFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Skills") &&
        nextFrame.includes("> skill-01") &&
        nextFrame.includes("showing 1-10 of 12"),
    );
    expect(firstFrame).toContain("Description 01");
    expect(firstFrame).toContain("skill-10");
    expect(firstFrame).not.toContain("skill-11");
    expect(firstFrame).not.toContain("skills:");

    app.stdin.write("\u001B[6~");
    const nextPageFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("> skill-11") &&
        nextFrame.includes("showing 11-12 of 12"),
    );
    expect(nextPageFrame).not.toContain("skill-01");
    expect(nextPageFrame).toContain("skill-12");

    app.stdin.write("\u001B[5~");
    await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("> skill-01") &&
        nextFrame.includes("showing 1-10 of 12"),
    );

    app.stdin.write("\u001B");
    await waitForFrame(
      app,
      (nextFrame) => !nextFrame.includes("showing 1-10 of 12"),
    );
  });

  it("routes /models into a read-only selector-ready panel without leaking connection secrets", async () => {
    const usage = contextWindowUsage("session_1", 51_600);
    const client = createFakeClient(
      {
        ...snapshot(),
        contextWindowUsages: [usage],
      },
      displayCommandCatalog,
    );
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await flush();
    app.stdin.write("/models");
    app.stdin.write("\r");
    await flush();

    const invocation = firstExecutedCommand(client);
    client.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId: "command_models",
      output: {
        data: {
          current: {
            active: true,
            apiKeyEnv: "ZENMUX_API_KEY",
            baseUrl: "https://proxy.example/v1?api_key=do-not-print",
            id: "glm-5.1",
            interfaceProvider: "openai-compatible",
            label: "GLM 5.1",
            model: "glm-5.1",
            provider: "zenmux",
          },
          models: [
            {
              active: true,
              id: "glm-5.1",
              interfaceProvider: "openai-compatible",
              label: "GLM 5.1",
              model: "glm-5.1",
              provider: "zenmux",
            },
          ],
          switching: {
            available: true,
            mode: "single-active-config",
          },
        },
        kind: "data",
        subject: "models.current",
      },
      timestamp: 1,
      type: "command.result.delivered",
    });

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Models") &&
        nextFrame.includes("GLM 5.1") &&
        nextFrame.includes("zenmux") &&
        nextFrame.includes("openai-compatible"),
    );
    expect(frame).toContain("Models (current)");
    expect(frame).toContain("Models (switch)");
    expect(frame).toContain("51.6K / 1M (5%)");
    expect(frame).not.toContain("Switching");
    expect(frame).not.toContain("single-active-config");
    expect(frame).not.toContain("do-not-print");
    expect(frame).not.toContain("ZENMUX_API_KEY");

    app.stdin.write("\u001B");
    await waitForFrame(app, (nextFrame) => !nextFrame.includes("GLM 5.1"));
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
        nextFrame.includes("/sessions - Choose a session"),
    );

    expect(frame).toContain("/models - Show current model");
    expect(frame).toContain("/sessions - Choose a session");
    expect(frame).not.toContain("/resume - Resume a session");

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

  it("windows slash candidates and pages through the full command list", async () => {
    const longDescription =
      "A very long command description that should not stretch the input area past a readable terminal width during dogfood sessions";
    const longCatalog: TuiCommandCatalog = {
      commands: Array.from({ length: 12 }, (_, index) => ({
        argumentMode: "argv" as const,
        category: "system",
        description: longDescription,
        id: `cmd.${String(index)}`,
        path: [`cmd${String(index)}`],
        source: "builtin" as const,
        surfaces: ["tui"],
      })),
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

    app.stdin.write("\u001B[6~");
    const pageFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("/cmd6") && nextFrame.includes("/cmd11"),
    );
    expect(pageFrame).not.toContain("/cmd0");
    expect(pageFrame).toContain("> /cmd6");
    expect(pageFrame).toContain("/cmd11");

    app.stdin.write("\r");
    await flush();

    expect(client.executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd.6",
        path: ["cmd6"],
      }),
    );
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

  it("renders session selections as paged cards with updated time metadata", async () => {
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
          label:
            index === 0
              ? "This is a very long generated session title that should truncate before the hidden tail becomes visible"
              : `Session ${String(index + 1)}`,
          metadata: {
            updatedAt: new Date(2026, 0, index + 1, 9, 30).getTime(),
          },
        })),
        prompt: "Select session",
        subject: "session",
      },
      timestamp: 1,
      type: "interaction.requested",
    });
    await flush();

    const firstFrame = app.lastFrame() ?? "";
    expect(firstFrame).toContain("Session");
    expect(firstFrame).toContain("showing 1-10 of 12");
    expect(firstFrame).toContain("pgup/pgdn");
    expect(firstFrame).toContain("01-01 09:30");
    expect(firstFrame).toContain("This is a very long generated session title");
    expect(firstFrame).toContain("...");
    expect(firstFrame).not.toContain("hidden tail");
    expect(firstFrame).toContain("Session 10");
    expect(firstFrame).not.toContain("Session 11");

    app.stdin.write("\u001B[6~");
    const pageFrame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("> Session 11") &&
        nextFrame.includes("showing 11-12 of 12"),
    );
    expect(pageFrame).not.toContain("Session 10");

    app.stdin.write("\r");
    await flush();

    expect(client.respondInteraction).toHaveBeenCalledWith("session_chooser", {
      choiceId: "session_11",
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

  it("defaults permission selection to first allow when available", async () => {
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
      choiceId: "allow",
    });
  });

  it("keeps escape on the deny permission safe default", async () => {
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
        id: "permission_3",
        runId: "run_1",
        title: "Permission",
      },
      type: "permission.requested",
    });
    await flush();

    app.stdin.write("\u001B");
    await flush();
    expect(client.respondPermission).toHaveBeenCalledWith("permission_3", {
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
  readonly archiveSession: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly connectModel: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly getContextWindowUsage: ReturnType<typeof vi.fn>;
  readonly getCurrentModel: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly probeModelContextWindow: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly setPermission: ReturnType<typeof vi.fn>;
  readonly setSearchApiKey: ReturnType<typeof vi.fn>;
  readonly submitPrompt: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<TuiEventHandler>();

  return {
    abortRun: vi.fn(() => Promise.resolve()),
    archiveSession: vi.fn(() => Promise.resolve()),
    compactSession: vi.fn(() =>
      Promise.resolve({
        sessionId: initialSnapshot.activeSessionId ?? "session_1",
        status: "not-needed" as const,
        usageAfter: {
          contextLimit: 100,
          currentTokens: 1,
          modelId: "fake-model",
          remainingTokens: 99,
          usageRatio: 0.01,
        },
        usageBefore: {
          contextLimit: 100,
          currentTokens: 1,
          modelId: "fake-model",
          remainingTokens: 99,
          usageRatio: 0.01,
        },
      }),
    ),
    connectModel: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://api.example.com",
        contextWindowSource: "default",
        contextWindowTokens: 128_000,
        envPath: ".env",
        interfaceProvider: "openai-compatible",
        model: "example-model",
        modelJsonPath: "model.json",
        provider: "example",
        saved: true,
      } as const),
    ),
    setSearchApiKey: vi.fn(() => Promise.resolve(searchConnectResult())),
    emit(event): void {
      for (const handler of handlers) {
        handler(event);
      }
    },
    executeCommand: vi.fn(() => Promise.resolve()),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() => Promise.resolve(initialSnapshot)),
    listCommands: vi.fn(() => Promise.resolve(commandCatalog)),
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default",
        contextWindowTokens: 128_000,
      } as const),
    ),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    setPermission: vi.fn(() =>
      Promise.resolve({
        level: "default",
        mode: "auto",
        sessionRules: [],
      } as const),
    ),
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function searchConnectResult(
  overrides: Partial<UiSetSearchApiKeyResult> = {},
): UiSetSearchApiKeyResult {
  return {
    apiKeyEnv: "TAVILY_API_KEY",
    envPath: ".env",
    provider: "tavily",
    searchJsonPath: "search.json",
    ...overrides,
  };
}

function connectResult(
  overrides: Partial<UiConnectModelResult> = {},
): UiConnectModelResult {
  return {
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.example/v1",
    contextWindowSource: "default",
    contextWindowTokens: 128_000,
    envPath: ".env",
    interfaceProvider: "openai-compatible",
    model: "anthropic/claude-sonnet-4.6",
    modelJsonPath: "model.json",
    provider: "zenmux",
    saved: true,
    ...overrides,
  };
}

async function openConnectForm(app: {
  readonly lastFrame: () => string | undefined;
  readonly stdin: { readonly write: (chunk: string) => void };
}): Promise<void> {
  await flush();
  app.stdin.write("/connect");
  app.stdin.write("\r");
  await waitForFrame(
    app,
    (nextFrame) =>
      nextFrame.includes("Connect") && nextFrame.includes("Provider"),
  );
  await settleConnectInput();
}

async function openConnectSearchForm(app: {
  readonly lastFrame: () => string | undefined;
  readonly stdin: { readonly write: (chunk: string) => void };
}): Promise<void> {
  await flush();
  app.stdin.write("/connect-search");
  app.stdin.write("\r");
  await waitForFrame(
    app,
    (nextFrame) =>
      nextFrame.includes("Connect Search") && nextFrame.includes("API key env"),
  );
  await settleConnectInput();
}

async function submitConnectField(
  app: {
    readonly lastFrame: () => string | undefined;
    readonly stdin: { readonly write: (chunk: string) => void };
  },
  value: string,
): Promise<void> {
  app.stdin.write("\r");
  await settleConnectInput();
  for (const char of value) {
    app.stdin.write(char);
    await flush();
  }
  await settleConnectInput();
  await waitForFrame(
    app,
    (nextFrame) => connectInputEchoed(nextFrame, value),
    2_000,
  );
  app.stdin.write("\r");
  await settleConnectInput();
}

async function sendConnectKey(
  app: { readonly stdin: { readonly write: (chunk: string) => void } },
  value: string,
): Promise<void> {
  app.stdin.write(value);
  await settleConnectInput();
}

async function settleConnectInput(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

function connectInputEchoed(frame: string, value: string): boolean {
  return frame.includes(value) || frame.includes("*".repeat(value.length));
}

function firstExecutedCommand(
  client: Pick<ReturnType<typeof createFakeClient>, "executeCommand">,
): UiCommandInvocation {
  const invocation = client.executeCommand.mock.calls[0]?.[0] as unknown;
  if (!isUiCommandInvocation(invocation)) {
    throw new Error("Expected executeCommand to be called");
  }
  return invocation;
}

async function waitForCommandCount(
  client: Pick<ReturnType<typeof createFakeClient>, "executeCommand">,
  count: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    await flush();
    if (client.executeCommand.mock.calls.length >= count) {
      return;
    }
  }
  throw new Error(
    `Timed out waiting for ${String(count)} executeCommand calls`,
  );
}

async function waitForConnectModelCount(
  client: Pick<ReturnType<typeof createFakeClient>, "connectModel">,
  count: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    await flush();
    if (client.connectModel.mock.calls.length >= count) {
      return;
    }
  }
  throw new Error(`Timed out waiting for ${String(count)} connectModel calls`);
}

function isUiCommandInvocation(value: unknown): value is UiCommandInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.clientInvocationId === "string" &&
    typeof record.commandId === "string" &&
    Array.isArray(record.path)
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
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
