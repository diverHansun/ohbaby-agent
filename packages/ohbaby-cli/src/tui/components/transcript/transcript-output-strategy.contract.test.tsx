import { EventEmitter } from "node:events";
import { Box, render, Static, Text } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../layout/app-shell.js";
import { ThemeProvider } from "../../theme/index.js";
import { CommittedTranscript } from "./committed-transcript.js";

const CLEAR_SCROLLBACK = "\u001b[3J";

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 12;
  readonly isTTY = true;
  readonly chunks: string[] = [];
  readonly write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
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

function mount(node: ReactElement, stdout: FakeStdout) {
  return render(node, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    patchConsole: false,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
}

function message(text: string): UiMessage {
  return {
    createdAt: "2026-10-03T00:00:00.000Z",
    id: "message_history",
    parts: [{ type: "text", text }],
    role: "assistant",
  };
}

function history(text: string): ReactElement {
  return (
    <ThemeProvider>
      <AppShell>
        <CommittedTranscript
          items={[
            {
              id: "message_history",
              messageId: "message_history",
              message: message(text),
              spacing: true,
            },
          ]}
        />
        <Text>input</Text>
      </AppShell>
    </ThemeProvider>
  );
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe("transcript output strategy acceptance", () => {
  beforeEach(() => {
    vi.stubEnv("OHBABY_TUI_STATIC_TRANSCRIPT", "");
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([3, 40])(
    "keeps %i history rows quiet across equivalent notifications",
    async (rows) => {
      const stdout = new FakeStdout();
      const text = Array.from(
        { length: rows },
        (_, i) => `history line ${String(i)}`,
      ).join("\n");
      const app = mount(history(text), stdout);
      try {
        await tick();
        const baseline = stdout.chunks.length;
        for (let index = 0; index < 3; index += 1) {
          app.rerender(history(text));
          await tick();
        }
        const updates = stdout.chunks.slice(baseline).join("");
        expect(updates.split(CLEAR_SCROLLBACK).length - 1).toBe(0);
        expect(updates).toBe("");
      } finally {
        app.unmount();
      }
    },
  );

  it("keeps default long history quiet on an equivalent notification (T01)", async () => {
    const stdout = new FakeStdout();
    const text = Array.from(
      { length: 40 },
      (_, i) => `history line ${String(i)}`,
    ).join("\n");
    const app = mount(history(text), stdout);
    try {
      await tick();
      const baseline = stdout.chunks.length;
      app.rerender(history(text));
      await tick();
      expect(stdout.chunks.slice(baseline).join("")).toBe("");
    } finally {
      app.unmount();
    }
  });

  it("refreshes a corrected existing message when Static is forced (T03)", async () => {
    vi.stubEnv("OHBABY_TUI_STATIC_TRANSCRIPT", "1");
    const stdout = new FakeStdout();
    const app = mount(history("original history"), stdout);
    try {
      await tick();
      const baseline = stdout.chunks.length;
      app.rerender(history("corrected history"));
      await tick();
      expect(stdout.chunks.slice(baseline).join("")).toContain(
        "corrected history",
      );
    } finally {
      app.unmount();
    }
  });

  it("keeps real historical corrections visible on the default dynamic path", async () => {
    const stdout = new FakeStdout();
    const app = mount(history("original history"), stdout);
    try {
      await tick();
      const baseline = stdout.chunks.length;
      app.rerender(history("corrected history"));
      await tick();
      expect(stdout.chunks.slice(baseline).join("")).toContain(
        "corrected history",
      );
    } finally {
      app.unmount();
    }
  });

  it("does not clear scrollback after public clear and equivalent history", async () => {
    const stdout = new FakeStdout();
    const text = Array.from(
      { length: 40 },
      (_, i) => `history line ${String(i)}`,
    ).join("\n");
    const app = mount(history(text), stdout);
    try {
      await tick();
      app.clear();
      const baseline = stdout.chunks.length;
      app.rerender(history(text));
      await tick();
      expect(stdout.chunks.slice(baseline).join("")).not.toContain(
        CLEAR_SCROLLBACK,
      );
    } finally {
      app.unmount();
    }
  });

  it("does not resurrect an old Static generation on resize", async () => {
    const stdout = new FakeStdout();
    const frame = (generation: number, text: string): ReactElement => (
      <Box flexDirection="column">
        <Static key={generation} items={[text]}>
          {(item) => <Text key={item}>{item}</Text>}
        </Static>
        <Text>{"live row\n".repeat(5)}input</Text>
      </Box>
    );
    const app = mount(frame(0, "original history"), stdout);
    try {
      await tick();
      app.clear();
      stdout.write("\u001b[2J\u001b[3J\u001b[H");
      app.rerender(frame(1, "corrected history"));
      await tick();
      const baseline = stdout.chunks.length;
      stdout.rows = 5;
      stdout.emit("resize");
      await tick();
      const resize = stdout.chunks.slice(baseline).join("");
      expect(resize).not.toContain(CLEAR_SCROLLBACK);
      expect(resize).not.toContain("original history");
      expect(resize).not.toContain("corrected history");
    } finally {
      app.unmount();
    }
  });
});
