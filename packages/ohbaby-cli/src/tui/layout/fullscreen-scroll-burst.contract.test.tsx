import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Terminal } from "@xterm/headless";
import { render, Text } from "ink";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.js";
import { createFrameCoalescingStdout } from "../terminal-output.js";

class TerminalOutput extends EventEmitter {
  readonly isTTY = true;
  readonly chunks: string[] = [];
  readonly columns = 64;
  readonly rows = 20;

  write(
    chunk: string,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): boolean {
    this.chunks.push(chunk);
    (typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback)?.();
    return true;
  }
}

class TerminalInput extends Readable {
  readonly isTTY = true;
  isRaw = false;
  override _read(): void {
    // Test input is pushed explicitly.
  }
  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function scene(rows: number, priorityDock = false): ReactElement {
  return (
    <AppShell
      fullscreen
      identity="burst"
      priorityDock={priorityDock}
      output={
        <Text>
          {Array.from(
            { length: rows },
            (_, index) => `ROW-${String(index).padStart(3, "0")}`,
          ).join("\n")}
        </Text>
      }
    >
      <Text>PROMPT</Text>
    </AppShell>
  );
}

interface Harness {
  readonly input: TerminalInput;
  readonly app: ReturnType<typeof render>;
  readonly drain: () => Promise<void>;
  readonly firstRow: () => number;
  readonly close: () => Promise<void>;
}

async function harness(priorityDock = false): Promise<Harness> {
  const input = new TerminalInput();
  const output = new TerminalOutput();
  const term = new Terminal({
    cols: output.columns,
    rows: output.rows,
    convertEol: true,
    allowProposedApi: true,
  });
  const app = render(scene(120, priorityDock), {
    alternateScreen: true,
    interactive: true,
    incrementalRendering: true,
    patchConsole: false,
    exitOnCtrlC: false,
    // SAFETY: the harness implements the stream and TTY APIs consumed by Ink.
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: createFrameCoalescingStdout(
      output as unknown as NodeJS.WriteStream,
    ),
  });
  let written = 0;
  const drain = async (): Promise<void> => {
    for (let turn = 0; turn < 2; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      await app.waitUntilRenderFlush();
    }
    await new Promise<void>((resolve) => {
      term.write(output.chunks.slice(written).join(""), resolve);
    });
    written = output.chunks.length;
  };
  await drain();
  const firstRow = (): number =>
    Number(
      term.buffer.active
        .getLine(0)
        ?.translateToString(true)
        .match(/ROW-(\d+)/u)?.[1],
    );
  return {
    input,
    app,
    drain,
    firstRow,
    close: async (): Promise<void> => {
      app.unmount();
      await app.waitUntilExit();
      input.destroy();
      term.dispose();
    },
  };
}

describe("fullscreen scrolling input bursts", () => {
  it("accumulates every wheel report from one input chunk", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      h.input.push("\u001b[<64;3;2M".repeat(5));
      await h.drain();
      expect(h.firstRow()).toBe(before - 15);
    } finally {
      await h.close();
    }
  });

  it("accumulates synchronous keyboard pages while output grows", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      h.input.push("\u001b[5;2~".repeat(2));
      h.app.rerender(scene(125));
      await h.drain();
      // 19 frame rows minus divider and one prompt row = 17 document rows.
      expect(h.firstRow()).toBe(before - 32);
    } finally {
      await h.close();
    }
  });

  it("accumulates reports from separate chunks arriving in one turn", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      for (let index = 0; index < 5; index++) h.input.push("\u001b[<64;3;2M");
      await h.drain();
      expect(h.firstRow()).toBe(before - 15);
    } finally {
      await h.close();
    }
  });

  it("applies mixed direction reports in order rather than only the last report", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      h.input.push("\u001b[<64;3;2M".repeat(3) + "\u001b[<65;3;2M".repeat(2));
      await h.drain();
      expect(h.firstRow()).toBe(before - 3);
    } finally {
      await h.close();
    }
  });

  it("keeps a burst-selected history position during output and resumes following at the bottom", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      h.input.push("\u001b[<64;3;2M".repeat(5));
      await h.drain();
      const reading = before - 15;
      expect(h.firstRow()).toBe(reading);
      for (const rows of [123, 126, 130]) {
        h.app.rerender(scene(rows));
        await h.drain();
        expect(h.firstRow()).toBe(reading);
      }
      h.input.push("\u001b[<65;3;2M".repeat(12));
      await h.drain();
      expect(h.firstRow()).toBe(before + 10);
      h.app.rerender(scene(133));
      await h.drain();
      expect(h.firstRow()).toBe(before + 13);
    } finally {
      await h.close();
    }
  });

  it("scrolls the transcript while the pointer is over the ordinary prompt dock", async () => {
    const h = await harness();
    try {
      const before = h.firstRow();
      h.input.push("\u001b[<64;3;19M");
      await h.drain();
      expect(h.firstRow()).toBe(before - 3);
    } finally {
      await h.close();
    }
  });

  it("keeps wheel input over a priority dialog separate from transcript scrolling", async () => {
    const h = await harness(true);
    try {
      const before = h.firstRow();
      h.input.push("\u001b[<64;3;19M");
      await h.drain();
      expect(h.firstRow()).toBe(before);
    } finally {
      await h.close();
    }
  });
});
