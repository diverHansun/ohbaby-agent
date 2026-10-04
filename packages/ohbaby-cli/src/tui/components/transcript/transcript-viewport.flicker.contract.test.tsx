import { stripVTControlCharacters } from "node:util";
import { EventEmitter } from "node:events";
import { render, Text, type DOMElement } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { createRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutProvider, LiveTailRefContext } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
import { ReplayableTranscript } from "./replayable-transcript.js";
import { AppShell } from "../../layout/app-shell.js";
import { ThemeProvider } from "../../theme/index.js";
import {
  advanceTranscriptCommit,
  type TranscriptCommitState,
} from "../../store/transcript.js";
import { TranscriptViewport } from "./transcript-viewport.js";

const CLEAR_SCROLLBACK = "[3J";

class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 12;
  readonly isTTY = true;
  readonly chunks: string[] = [];

  readonly write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };

  output(): string {
    return this.chunks.join("");
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): null {
    return null;
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}

describe("TranscriptViewport streaming render contract", () => {
  beforeEach(() => {
    vi.stubEnv("OHBABY_TUI_STATIC_TRANSCRIPT", "1");
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never clears the terminal scrollback while a tall live message streams", async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();

    const app = render(viewport(liveMessage(40)), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      await waitForRenderTick();
      app.rerender(viewport(liveMessage(80)));
      await waitForRenderTick();
      app.rerender(viewport(liveMessage(120)));
      await waitForRenderTick();

      expect(stdout.output()).not.toContain(CLEAR_SCROLLBACK);
      expect(stdout.output()).not.toContain("\u001b[2J");
      // Already produced text must enter native scrollback before completion.
      expect(stdout.output()).toContain("streamed token line 0");
      expect(
        stripVTControlCharacters(stdout.output()).match(
          /streamed token line 0(?=\r?\n)/gu,
        ),
      ).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });
  it("keeps streamed rows exactly once across approval height changes, sealed tools and completion", async () => {
    const stdout = new FakeStdout();
    const running = { kind: "running", runId: "run_1" } as const;
    let state: TranscriptCommitState | undefined;
    const frame = (
      message: UiMessage,
      controls = 0,
      idle = false,
    ): ReactElement => {
      state = advanceTranscriptCommit(
        state,
        [committedMessage(), message],
        idle ? { kind: "idle" } : running,
      );
      return (
        <ThemeProvider>
          <AppShell>
            <TranscriptViewport
              commandNotices={[]}
              committedItems={state.committedItems}
              liveMessage={state.liveMessage}
              notices={[]}
              runtime={idle ? { kind: "idle" } : running}
            />
            {controls > 0 ? (
              <Text>
                {"approval controls\n".repeat(controls - 1) + "approval action"}
              </Text>
            ) : null}
          </AppShell>
        </ThemeProvider>
      );
    };
    const message = liveMessage(40);
    const app = render(frame(message), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      await waitForRenderTick();
      app.rerender(frame(message, 9));
      await waitForRenderTick();
      app.rerender(frame(message));
      await waitForRenderTick();
      const withTool: UiMessage = {
        ...message,
        parts: [
          ...message.parts,
          {
            type: "tool-call",
            call: {
              id: "stream-tool",
              name: "read",
              input: { file_path: "stream.ts" },
              status: "running",
            },
          },
        ],
      };
      app.rerender(frame(withTool));
      await waitForRenderTick();
      const completed: UiMessage = {
        ...withTool,
        status: "completed",
        parts: [
          ...message.parts,
          {
            type: "tool-call",
            call: {
              id: "stream-tool",
              name: "read",
              input: { file_path: "stream.ts" },
              status: "completed",
            },
          },
          {
            type: "tool-result",
            result: { callId: "stream-tool", output: "tool complete" },
          },
        ],
      };
      app.rerender(frame(completed, 0, true));
      await waitForRenderTick();
      expect(stdout.output()).not.toContain(CLEAR_SCROLLBACK);
      expect(stdout.output()).not.toContain("\u001b[2J");
      expect(
        stripVTControlCharacters(stdout.output()).match(
          /streamed token line 0(?=\r?\n)/gu,
        ),
      ).toHaveLength(1);
      expect(stdout.output()).toContain("Read");
    } finally {
      app.unmount();
    }
  });

  it.each(["code", "table"])(
    "makes the start of a long %s block readable before its last row arrives",
    async (kind) => {
      const stdout = new FakeStdout();
      const block = (count: number): UiMessage => ({
        ...liveMessage(count),
        parts: [
          {
            type: "text",
            text:
              kind === "code"
                ? "```ts\n" +
                  Array.from(
                    { length: count },
                    (_, index) =>
                      `const LINE${String(index).padStart(3, "0")} = '中文';`,
                  ).join("\n")
                : "| Row | Content |\n| --- | --- |\n" +
                  Array.from(
                    { length: count },
                    (_, index) =>
                      `| LINE${String(index).padStart(3, "0")} | 中文 |`,
                  ).join("\n"),
          },
        ],
      });
      const app = render(viewport(block(30)), {
        exitOnCtrlC: false,
        incrementalRendering: true,
        patchConsole: false,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      try {
        await waitForRenderTick();
        expect(stdout.output()).toContain("LINE000");
        const boundary = stdout.chunks.length;
        app.rerender(viewport(block(60)));
        await waitForRenderTick();
        expect(stdout.chunks.slice(boundary).join("")).not.toContain("LINE000");
        expect(stdout.output()).toContain("LINE059");
        expect(stdout.output()).not.toContain(CLEAR_SCROLLBACK);
        expect(stdout.output()).not.toContain("\u001b[2J");
      } finally {
        app.unmount();
      }
    },
  );

  it.each([1, 2, 3])(
    "keeps the newest row in a %i-row control-constrained tail",
    async (budget) => {
      for (const measured of [false, true]) {
        const stdout = new FakeStdout();
        const app = render(
          <ThemeProvider>
            <LayoutProvider
              value={{
                ...computeLayoutMetrics({ columns: 80, rows: 12 }),
                liveTailRows: budget,
              }}
            >
              <LiveTailRefContext.Provider
                value={measured ? createRef<DOMElement>() : undefined}
              >
                <ReplayableTranscript
                  items={[]}
                  liveMessage={liveMessage(20)}
                />
              </LiveTailRefContext.Provider>
            </LayoutProvider>
          </ThemeProvider>,
          {
            exitOnCtrlC: false,
            incrementalRendering: true,
            patchConsole: false,
            stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
            stdout: stdout as unknown as NodeJS.WriteStream,
          },
        );
        try {
          await waitForRenderTick();
          const output = stripVTControlCharacters(stdout.output());
          const available = budget - (measured ? 1 : 0);
          if (available > 0) expect(output).toContain("streamed token line 19");
          else expect(output).not.toContain("streamed token line 19");
          // Rows not yet committed must be the latest ones, never the head of
          // the four-row tail that Yoga may shrink or clip under tall controls.
          expect(output).not.toContain("streamed token line 16");
          expect(output).not.toContain(CLEAR_SCROLLBACK);
        } finally {
          app.unmount();
        }
      }
    },
  );

  it.each(["table", "list"])(
    "defers changing %s layout until completion without clearing on each token",
    async (kind) => {
      const stdout = new FakeStdout();
      const source =
        kind === "table"
          ? "| Key | Value |\n| --- | --- |\n" +
            Array.from(
              { length: 20 },
              (_, index) => `| ROW${String(index).padStart(2, "0")} | a |`,
            ).join("\n")
          : Array.from(
              { length: 20 },
              (_, index) => `- ROW${String(index).padStart(2, "0")}`,
            ).join("\n");
      const initial: UiMessage = {
        ...liveMessage(0),
        parts: [{ type: "text", text: source }],
      };
      const app = render(viewport(initial), {
        exitOnCtrlC: false,
        incrementalRendering: true,
        patchConsole: false,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      try {
        await waitForRenderTick();
        const boundary = stdout.chunks.length;
        let current = initial;
        for (let count = 6; count <= 10; count++) {
          current = {
            ...initial,
            parts: [
              {
                type: "text",
                text:
                  source +
                  (kind === "table"
                    ? "\n| ROW20 | " + "x".repeat(count)
                    : "\n\n  continuation " + "x".repeat(count)),
              },
            ],
          };
          app.rerender(viewport(current));
          await waitForRenderTick();
        }
        const updates = stdout.chunks.slice(boundary).join("");
        expect(updates).not.toContain(CLEAR_SCROLLBACK);
        expect(updates).not.toContain("\u001b[2J");
        expect(updates).not.toContain("ROW00");
        expect(stripVTControlCharacters(updates)).toContain(
          "pending final layout",
        );
        const completeAt = stdout.chunks.length;
        app.rerender(viewport({ ...current, status: "completed" }, true));
        await waitForRenderTick();
        const completion = stdout.chunks.slice(completeAt).join("");
        expect(completion.split(CLEAR_SCROLLBACK)).toHaveLength(2);
        expect(completion).toContain("ROW00");
        expect(completion).toContain("ROW19");
        expect(completion).toContain("xxxxxxxxxx");
        expect(
          completion.slice(completion.indexOf(CLEAR_SCROLLBACK)),
        ).not.toContain("pending final layout");
        const settled = stdout.chunks.length;
        app.rerender(viewport({ ...current, status: "completed" }, true));
        await waitForRenderTick();
        expect(stdout.chunks.slice(settled).join("")).toBe("");
      } finally {
        app.unmount();
      }
    },
  );

  it.each([1, 2, 3])(
    "keeps the newest text alongside a deferred-layout cue in %i available rows",
    async (budget) => {
      const stdout = new FakeStdout();
      const source = Array.from(
        { length: 20 },
        (_, index) => `- LIST${String(index)}`,
      ).join("\n");
      const scene = (text: string): ReactElement => (
        <ThemeProvider>
          <LayoutProvider
            value={{
              ...computeLayoutMetrics({ columns: 80, rows: 12 }),
              liveTailRows: budget,
            }}
          >
            <ReplayableTranscript
              items={[]}
              liveMessage={{
                ...liveMessage(0),
                parts: [{ type: "text", text }],
              }}
            />
          </LayoutProvider>
        </ThemeProvider>
      );
      const app = render(scene(source), {
        exitOnCtrlC: false,
        incrementalRendering: true,
        patchConsole: false,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      try {
        await waitForRenderTick();
        const boundary = stdout.chunks.length;
        app.rerender(scene(source + "\n\n  LATEST-TEXT"));
        await waitForRenderTick();
        const update = stripVTControlCharacters(
          stdout.chunks.slice(boundary).join(""),
        );
        expect(update).toContain("LATEST-TEXT");
        expect(update).toContain(budget === 1 ? "… " : "pending final layout");
        expect(stdout.chunks.slice(boundary).join("")).not.toContain(
          CLEAR_SCROLLBACK,
        );
      } finally {
        app.unmount();
      }
    },
  );

  it("corrects a sealed fragment immediately even when the same message continues streaming", async () => {
    const stdout = new FakeStdout();
    const scene = (sealed: string, lineCount: number): ReactElement => (
      <ThemeProvider>
        <AppShell>
          <ReplayableTranscript
            items={[
              {
                id: "message_live#0-1",
                messageId: "message_live",
                message: {
                  ...liveMessage(0),
                  status: "completed",
                  parts: [{ type: "text", text: sealed }],
                },
                spacing: false,
              },
            ]}
            liveMessage={liveMessage(lineCount)}
          />
        </AppShell>
      </ThemeProvider>
    );
    const app = render(scene("SEALED original", 20), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      await waitForRenderTick();
      const boundary = stdout.chunks.length;
      app.rerender(scene("SEALED corrected", 21));
      await waitForRenderTick();
      const update = stdout.chunks.slice(boundary).join("");
      expect(update.split(CLEAR_SCROLLBACK)).toHaveLength(2);
      expect(update).toContain("SEALED corrected");
    } finally {
      app.unmount();
    }
  });

  it("replays a real Markdown prefix correction once and keeps later equivalent frames quiet", async () => {
    const stdout = new FakeStdout();
    const initial = liveMessage(40);
    const app = render(viewport(initial), {
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    try {
      await waitForRenderTick();
      const boundary = stdout.chunks.length;
      const corrected: UiMessage = {
        ...initial,
        parts: [
          {
            type: "text",
            text:
              "# CORRECTED HEADING\n" +
              (initial.parts[0] as { text: string }).text,
          },
        ],
      };
      app.rerender(viewport(corrected));
      await waitForRenderTick();
      expect(
        stdout.chunks.slice(boundary).join("").split(CLEAR_SCROLLBACK),
      ).toHaveLength(2);
      expect(stdout.chunks.slice(boundary).join("")).toContain(
        "CORRECTED HEADING",
      );
      const settled = stdout.chunks.length;
      app.rerender(viewport(corrected));
      await waitForRenderTick();
      expect(stdout.chunks.slice(settled).join("")).toBe("");
    } finally {
      app.unmount();
    }
  });
});

function viewport(live: UiMessage, completed = false): ReactElement {
  return (
    <ThemeProvider>
      <AppShell>
        <TranscriptViewport
          commandNotices={[]}
          committedItems={[
            {
              id: "message_committed",
              message: committedMessage(),
              messageId: "message_committed",
              spacing: true,
            },
            ...(completed
              ? [
                  {
                    id: live.id,
                    message: live,
                    messageId: live.id,
                    spacing: true,
                  },
                ]
              : []),
          ]}
          liveMessage={completed ? null : live}
          notices={[]}
          runtime={{ kind: "running", runId: "run_1" }}
        />
      </AppShell>
    </ThemeProvider>
  );
}

function committedMessage(): UiMessage {
  return {
    createdAt: "2026-06-10T00:00:00.000Z",
    id: "message_committed",
    parts: [{ text: "committed answer", type: "text" }],
    role: "assistant",
  };
}

function liveMessage(lineCount: number): UiMessage {
  const text = Array.from(
    { length: lineCount },
    (_, index) => `streamed token line ${String(index)}`,
  ).join("\n");

  return {
    createdAt: "2026-06-10T00:00:01.000Z",
    id: "message_live",
    parts: [{ text, type: "text" }],
    role: "assistant",
    status: "streaming",
  };
}

async function waitForRenderTick(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
}
