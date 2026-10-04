import { EventEmitter } from "node:events";
import { Terminal } from "@xterm/headless";
import { Box, Text, render } from "ink";
import type { ReactElement } from "react";
import type { UiMessage } from "ohbaby-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { AppShell } from "./layout/app-shell.js";
import { TranscriptViewport } from "./components/transcript/transcript-viewport.js";
import {
  advanceTranscriptCommit,
  type TranscriptCommitState,
} from "./store/transcript.js";
import { ThemeProvider, createTheme } from "./theme/index.js";
import { createFrameCoalescingStdout } from "./terminal-output.js";

const BSU = "\u001b[?2026h";
const ESU = "\u001b[?2026l";
const terminals: Terminal[] = [];

function terminal(columns = 40, rows = 12): Terminal {
  const term = new Terminal({
    cols: columns,
    rows,
    convertEol: true,
    allowProposedApi: true,
    scrollback: 2000,
  });
  terminals.push(term);
  return term;
}

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    term.write(data, resolve);
  });
}

interface TerminalSnapshot {
  readonly cursor: readonly number[];
  readonly base: number;
  readonly viewport: number;
  readonly lines: readonly {
    readonly wrapped: boolean;
    readonly cells: readonly (readonly (string | number)[])[];
  }[];
}

/** Public xterm buffer state, including styled cells, cursor and native history. */
function snapshot(term: Terminal): TerminalSnapshot {
  const buffer = term.buffer.active;
  return {
    cursor: [buffer.cursorX, buffer.cursorY],
    base: buffer.baseY,
    viewport: buffer.viewportY,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      if (!line) throw new Error(`Missing terminal row ${String(index)}`);
      return {
        wrapped: line.isWrapped,
        cells: Array.from({ length: line.length }, (_, column) => {
          const cell = line.getCell(column);
          if (!cell) throw new Error(`Missing terminal cell ${String(column)}`);
          return [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColor(),
            cell.getBgColor(),
            cell.isBold(),
            cell.isInverse(),
          ];
        }),
      };
    }),
  };
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  vi.unstubAllEnvs();
});

class Output extends EventEmitter {
  readonly isTTY = true;
  readonly chunks: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write = (
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean => {
    this.chunks.push(chunk);
    callback?.();
    return true;
  };
}

class Input extends EventEmitter {
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

it.each([
  [80, 24],
  [40, 12],
])(
  "coalesces real Ink token frames without changing cells or cursor at %ix%i",
  async (columns, rows) => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
    const original = new Output(columns, rows);
    const target = new Output(columns, rows);
    // SAFETY: these test streams provide Ink's TTY dimensions, events and IO methods.
    const adapted = createFrameCoalescingStdout(
      target as unknown as NodeJS.WriteStream,
    );
    original.write = (chunk, callback): boolean => {
      original.chunks.push(chunk);
      return adapted.write(chunk, callback);
    };
    const before = terminal(columns, rows);
    const after = terminal(columns, rows);
    await write(before, "shell\n");
    await write(after, "shell\n");
    const theme = createTheme("dark", 3);
    const user: UiMessage = {
      id: "user",
      createdAt: "2026-10-04T00:00:00Z",
      role: "user",
      parts: [{ type: "text", text: "history\n".repeat(35) }],
    };
    let state: TranscriptCommitState | undefined;
    const scene = (text: string, complete = false): ReactElement => {
      const message: UiMessage = {
        id: "live",
        createdAt: "2026-10-04T00:00:01Z",
        role: "assistant",
        status: complete ? "completed" : "streaming",
        parts: [{ type: "text", text }],
      };
      state = advanceTranscriptCommit(
        state,
        [user, message],
        complete ? { kind: "idle" } : { kind: "running", runId: "run" },
      );
      return (
        <ThemeProvider theme={theme}>
          <AppShell
            fullscreen
            output={
              <TranscriptViewport
                committedItems={state.committedItems}
                liveMessage={state.liveMessage}
                commandNotices={[]}
                notices={[]}
                runtime={{ kind: "idle" }}
              />
            }
          >
            <Box flexDirection="column">
              <Text>──────</Text>
              <Text>{"> 中文草稿 é"}</Text>
              <Text>──────</Text>
              <Text>model · mode</Text>
            </Box>
          </AppShell>
        </ThemeProvider>
      );
    };
    const app = render(scene(""), {
      alternateScreen: true,
      exitOnCtrlC: false,
      incrementalRendering: true,
      patchConsole: false,
      // SAFETY: local fake implements the stream subset exercised by Ink.
      stdout: original as unknown as NodeJS.WriteStream,
      stdin: new Input() as unknown as NodeJS.ReadStream,
    });
    const source =
      "# 标题\n\n这是包含 **强调** 的流式文字，自动折行后继续显示。\n\n- item one\n- item two\n\n```ts\nconst n = 1;\n" +
      "x();\n".repeat(20) +
      "```\n\n| Key | Value |\n|---|---|\n| one | long cell |\n\n完毕。";
    let originalOffset = 0;
    let targetOffset = 0;
    let frames = 0;
    const drain = async (): Promise<void> => {
      await app.waitUntilRenderFlush();
      const raw = original.chunks.slice(originalOffset).join("");
      const updated = target.chunks.slice(targetOffset).join("");
      expect(updated).toBe(raw);
      for (const chunk of target.chunks.slice(targetOffset)) {
        if (!chunk.includes(BSU)) continue;
        frames++;
        expect(chunk.startsWith(BSU)).toBe(true);
        expect(chunk.endsWith(ESU)).toBe(true);
        expect(chunk.split(BSU)).toHaveLength(2);
        expect(chunk.split(ESU)).toHaveLength(2);
      }
      await write(before, raw);
      await write(after, updated);
      expect(snapshot(after)).toEqual(snapshot(before));
      originalOffset = original.chunks.length;
      targetOffset = target.chunks.length;
    };
    try {
      await drain();
      expect(after.buffer.active.type).toBe("alternate");
      const pinned = 0;
      let text = "";
      for (const char of source) {
        text += char;
        app.rerender(scene(text));
        await drain();
        expect(after.buffer.active.viewportY).toBe(pinned);
      }
      app.rerender(scene(text, true));
      await drain();
      expect(after.buffer.active.viewportY).toBe(pinned);
      expect(frames).toBeGreaterThan(10);
      // An equivalent refresh must stay quiet too.
      app.rerender(scene(text, true));
      await drain();
      expect(after.buffer.active.viewportY).toBe(pinned);
    } finally {
      app.unmount();
      await app.waitUntilExit();
      const raw = original.chunks.slice(originalOffset).join("");
      const updated = target.chunks.slice(targetOffset).join("");
      expect(updated).toBe(raw);
      await write(before, raw);
      await write(after, updated);
      expect(snapshot(after)).toEqual(snapshot(before));
      expect(after.buffer.active.type).toBe("normal");
      expect(after.buffer.normal.getLine(0)?.translateToString(true)).toBe(
        "shell",
      );
    }
  },
  20000,
);
