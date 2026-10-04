import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import type {
  CoreAPI,
  UiEventHandler,
  UiSessionView,
  UiCommandInvocation,
} from "ohbaby-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { renderTerminalUi } from "./index.js";

vi.mock("./pending-prompts.js", () => ({
  createPendingPromptStorage: (): { read(): never[]; write(): void } => ({
    read: (): never[] => [],
    write: (): void => undefined,
  }),
}));

class Output extends EventEmitter {
  readonly columns = 80;
  rows = 20;
  readonly chunks: string[] = [];
  constructor(readonly isTTY = true) {
    super();
  }
  write(
    chunk: string,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): boolean {
    this.chunks.push(chunk);
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    else callback?.();
    return true;
  }
}
class Input extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function backend(): {
  client: CoreAPI;
  subscribeEvents(handler: UiEventHandler): () => void;
  appendFinalDelta(): void;
  emit(event: Parameters<UiEventHandler>[0]): void;
} {
  const now = "2026-10-04T00:00:00Z";
  const view: UiSessionView = {
    version: {
      runtimeEpoch: "e",
      sessionId: "s",
      viewGeneration: "v",
      sessionRevision: 1,
    },
    session: {
      id: "s",
      title: "exit fixture",
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: "first",
          role: "user",
          createdAt: now,
          parts: [{ type: "text", text: "FIRST-USER" }],
        },
        {
          id: "history",
          role: "assistant",
          status: "completed",
          createdAt: now,
          parts: [
            {
              type: "text",
              text: Array.from(
                { length: 35 },
                (_, i) => `HISTORY-${String(i).padStart(2, "0")}`,
              ).join("\n"),
            },
          ],
        },
        {
          id: "internal",
          role: "system",
          runtimeInputKind: "subagent-status",
          createdAt: now,
          parts: [{ type: "text", text: "PRIVATE-STATUS" }],
        },
        {
          id: "live",
          role: "assistant",
          status: "streaming",
          createdAt: now,
          parts: [
            {
              type: "text",
              text: Array.from(
                { length: 35 },
                (_, i) => `LIVE-${String(i).padStart(2, "0")}`,
              ).join("\n"),
            },
          ],
        },
      ],
    },
    runs: [
      {
        id: "r",
        sessionId: "s",
        startedAt: now,
        updatedAt: now,
        status: { kind: "idle" },
      },
    ],
    prompts: [],
    history: { hasMore: false },
    reasoningMissing: false,
    goal: { status: "ready", value: null },
    todo: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
  const handlers = new Set<UiEventHandler>();
  const client = {
    getSelectedSessionId: () => Promise.resolve("s"),
    getSessionIndex: () => Promise.resolve([view.session]),
    getSessionView: () => Promise.resolve(view),
    getSessionHistory: () =>
      Promise.resolve({
        version: view.version,
        messages: [],
        prompts: [],
        hasMore: false,
        reasoningMissing: false,
      }),
    getSessionControl: () =>
      Promise.resolve({
        runtimeEpoch: "e",
        sessionId: "s",
        rootSessionId: "s",
        runId: "r",
        driver: "user",
      }),
    getPromptReceipt: () =>
      Promise.resolve({
        runtimeEpoch: "e",
        clientRequestId: "unused",
        receipt: null,
      }),
    getPermissionSnapshot: () =>
      Promise.resolve({
        permissionEpoch: "e",
        rootSessionId: "s",
        permissionRevision: 0,
        requests: [],
      }),
    subscribePermissionEvents: (): (() => void) => () => undefined,
    executeCommand: (invocation: UiCommandInvocation) => {
      queueMicrotask(() => {
        for (const handler of handlers)
          handler({
            type: "command.result.delivered",
            clientInvocationId: invocation.clientInvocationId,
            commandRunId: "models",
            timestamp: 1,
            output: {
              kind: "data",
              subject: "models",
              data: {
                current: {
                  model: "fixture-model",
                  provider: "fixture",
                  interfaceProvider: "anthropic",
                },
                models: Array.from({ length: 8 }, (_, index) => ({
                  id: `candidate-${String(index)}`,
                  provider: "fixture",
                })),
              },
            },
          });
      });
      return Promise.resolve({
        status: "completed",
        commandRunId: "models",
        clientInvocationId: invocation.clientInvocationId,
        outputCount: 1,
        eventCount: 1,
      });
    },
    getCurrentModel: () => Promise.resolve(null),
    getContextWindowUsage: () => Promise.resolve(null),
    listCommands: () =>
      Promise.resolve({
        version: "1",
        commands: [
          {
            id: "models",
            path: ["models"],
            description: "Models",
            surfaces: ["tui"],
            argumentMode: "argv",
            category: "system",
            source: "builtin",
          },
          {
            id: "connect",
            path: ["connect"],
            description: "Connect",
            kind: "action",
            surfaces: ["tui"],
            aliases: [],
            arguments: [],
          },
          {
            id: "connect-search",
            path: ["connect-search"],
            description: "Search",
            surfaces: ["tui"],
            argumentMode: "argv",
            category: "system",
            source: "builtin",
          },
        ],
      }),
    getSubagentExecutionView: ({ executionId }: { executionId: string }) =>
      Promise.resolve({
        execution: {
          executionId,
          subagentId: "agent-24",
          rootSessionId: "s",
          rootRunId: "r",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          resultStored: true,
          delivery: "processed",
        },
        messages: [
          {
            id: "detail",
            role: "assistant",
            createdAt: now,
            parts: [
              {
                type: "text",
                text: Array.from(
                  { length: 35 },
                  (_, i) => `DETAIL-${String(i)}`,
                ).join("\n"),
              },
            ],
          },
        ],
        history: { hasMore: false },
      }),
    listSubagentExecutions: () =>
      Promise.resolve({
        executions: Array.from({ length: 25 }, (_, i) => ({
          executionId: `execution-${String(i)}`,
          subagentId: `agent-${String(i)}`,
          rootSessionId: "s",
          rootRunId: "r",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          resultStored: true,
          delivery: "processed",
        })),
        activeCount: 0,
        completedCount: 25,
        waiting: false,
        approvalBlocked: false,
        hasMore: false,
      }),
  } as unknown as CoreAPI;
  return {
    client,
    subscribeEvents(handler: UiEventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    appendFinalDelta(): void {
      const message = view.session.messages.at(-1);
      if (!message) throw new Error("missing fixture message");
      const event = {
        type: "session.changed",
        version: { ...view.version, sessionRevision: 2 },
        messages: [
          {
            ...message,
            parts: [
              ...message.parts,
              { type: "text", text: "LAST-PENDING-DELTA" },
            ],
          },
        ],
      } as const;
      for (const handler of handlers) handler(event);
    },
    emit(event: Parameters<UiEventHandler>[0]): void {
      for (const handler of handlers) handler(event);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([24, 12])(
  "keeps connection fields and subagent navigation visible in fullscreen at 80x%s",
  async (rows) => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
    const output = new Output();
    output.rows = rows;
    const input = new Input();
    vi.spyOn(process, "stdout", "get").mockReturnValue(
      output as unknown as typeof process.stdout,
    );
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      input as unknown as typeof process.stdin,
    );
    const fixture = backend();
    const app = renderTerminalUi(fixture);
    const terminal = new Terminal({
      cols: 80,
      rows,
      convertEol: true,
      allowProposedApi: true,
    });
    let offset = 0;
    const drain = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 50));
      await app.waitUntilRenderFlush();
      await new Promise<void>((resolve) => {
        terminal.write(output.chunks.slice(offset).join(""), resolve);
      });
      offset = output.chunks.length;
      return Array.from(
        { length: rows },
        (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
      ).join("\n");
    };
    try {
      await drain();
      await drain();
      input.write("/connect");
      await drain();
      input.write("\r");
      let screen = await drain();
      await drain();

      expect(screen).toContain("Connect");
      expect(screen).toContain("> Provider");
      input.write("\r");
      await drain();
      input.write("probe-provider");
      screen = await drain();
      expect(screen).toContain("probe-provider");
      input.write("x".repeat(120) + "INPUT-END");
      screen = await drain();
      expect(screen).toContain("INPUT-END");
      expect(screen).toContain("▏ [editing]");
      input.write("\u001b");
      await drain();
      for (const label of [
        "Base URL",
        "API key env",
        "API key value",
        "Model name",
        "Context window",
        "Max output tokens",
        "Protocol",
      ]) {
        input.write("\u001b[B");
        screen = await drain();
        expect(screen).toContain(`> ${label}`);
        expect(screen).toContain("Connect");
      }
      input.write("\r");
      await drain();
      input.write("\u001b[B");
      screen = await drain();
      expect(screen).toContain("> openai-responses");
      expect(screen).toContain("Protocol");
      input.write("\u001b");
      await drain();
      input.write("\u001b");
      await drain();
      input.write("/connect-search");
      await drain();
      input.write("\r");
      screen = await drain();
      expect(screen).toContain("> Provider");
      input.write("\u001b[B");
      await drain();
      input.write("\u001b[B");
      screen = await drain();
      expect(screen).toContain("> API key value");
      input.write("\r");
      await drain();
      input.write("fixture-key");
      screen = await drain();
      expect(screen).toContain("[editing]");
      expect(screen).not.toContain("fixture-key");
      input.write("\u001b");
      await drain();
      input.write("\u001b");
      await drain();
      input.write("/models");
      await drain();
      input.write("\r");
      screen = await drain();
      expect(screen).toContain("Models");
      expect(screen).toContain("fixture-model");
      for (let i = 0; i < 4; i++) {
        input.write("\u001b[6~");
        screen = await drain();
      }
      expect(screen).toContain("candidate-7");
      expect(screen).toContain("Models");
      input.write("\u001b");
      await drain();
      input.write("\u0007");
      screen = await drain();
      for (let i = 0; i < 24; i++) {
        input.write("\u001b[B");
        await drain();
      }
      screen = await drain();
      expect(screen).toContain("Subagents · Read only");
      expect(screen).toContain("› agent-24");
      input.write("\r");
      screen = await drain();
      expect(screen).toContain("Subagents · Read only");
      expect(screen).toContain("DETAIL-0");
      for (let i = 0; i < 10; i++) {
        input.write("\u001b[6~");
        screen = await drain();
      }
      expect(screen).toContain("DETAIL-34");
    } finally {
      app.unmount();
      await app.waitUntilExit();
      input.destroy();
      terminal.dispose();
    }
  },
);
