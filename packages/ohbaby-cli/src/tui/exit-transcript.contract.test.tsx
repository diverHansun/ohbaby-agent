import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import { useApp } from "ink";
import { useEffect } from "react";
import type { CoreAPI, UiEventHandler, UiSessionView } from "ohbaby-sdk";
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
  readonly rows = 20;
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
        status: { kind: "running", runId: "r" },
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
    getCurrentModel: () => Promise.resolve(null),
    getContextWindowUsage: () => Promise.resolve(null),
    listCommands: () => Promise.resolve({ version: "1", commands: [] }),
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

it.each(["command", "unmount", "error"] as const)(
  "preserves the complete transcript once in the normal buffer on %s exit",
  async (exitKind) => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
    const output = new Output();
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
      cols: output.columns,
      rows: output.rows,
      scrollback: 2000,
      convertEol: true,
      allowProposedApi: true,
    });
    const write = async (text: string): Promise<void> => {
      await new Promise<void>((resolve) => {
        terminal.write(text, resolve);
      });
    };
    const screen = (): string =>
      Array.from(
        { length: terminal.buffer.active.length },
        (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
      ).join("\n");
    try {
      await write("SHELL-BEFORE\n");
      await app.waitUntilRenderFlush();
      await app.waitUntilRenderFlush();
      await write(output.chunks.join(""));
      expect(terminal.buffer.active.type).toBe("alternate");
      expect(screen()).toContain("LIVE-34");
      const offset = output.chunks.length;
      fixture.appendFinalDelta();
      const error = new Error("exit-test-error");
      if (exitKind === "command")
        fixture.emit({
          type: "command.result.delivered",
          clientInvocationId: "exit",
          commandRunId: "exit",
          timestamp: 1,
          output: { kind: "text", text: "" },
          action: { kind: "app.exit" },
        });
      else if (exitKind === "error") app.rerender(<ExitError error={error} />);
      else app.unmount();
      if (exitKind === "error")
        await expect(app.waitUntilExit()).rejects.toBe(error);
      else await app.waitUntilExit();
      app.unmount();
      await app.waitUntilExit().catch(() => undefined);
      await write(output.chunks.slice(offset).join(""));
      expect(terminal.buffer.active.type).toBe("normal");
      const text = screen();
      expect(text).toContain("SHELL-BEFORE");
      expect(text.match(/FIRST-USER/g)).toHaveLength(1);
      for (let i = 0; i < 35; i++) {
        expect(
          text.match(new RegExp(`HISTORY-${String(i).padStart(2, "0")}`, "g")),
        ).toHaveLength(1);
        expect(
          text.match(new RegExp(`LIVE-${String(i).padStart(2, "0")}`, "g")),
        ).toHaveLength(1);
      }
      expect(text.match(/LAST-PENDING-DELTA/g)).toHaveLength(1);
      expect(text).not.toContain("PRIVATE-STATUS");
      expect(terminal.modes.mouseTrackingMode).toBe("none");
    } finally {
      app.unmount();
      await app.waitUntilExit().catch(() => undefined);
      input.destroy();
      terminal.dispose();
    }
  },
);

function ExitError({ error }: { readonly error: Error }): null {
  const { exit } = useApp();
  useEffect(() => {
    exit(error);
  }, [exit, error]);
  return null;
}

it("does not replay the document a second time for piped output", async () => {
  vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
  const output = new Output(false);
  const input = new Input();
  vi.spyOn(process, "stdout", "get").mockReturnValue(
    output as unknown as typeof process.stdout,
  );
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    input as unknown as typeof process.stdin,
  );
  const app = renderTerminalUi(backend());
  try {
    await app.waitUntilRenderFlush();
    await app.waitUntilRenderFlush();
    app.unmount();
    await app.waitUntilExit();
    const text = output.chunks.join("");
    expect(text.match(/FIRST-USER/g)).toHaveLength(1);
    expect(text).not.toContain("\u001b[?1049h");
  } finally {
    app.unmount();
    await app.waitUntilExit();
    input.destroy();
  }
});
