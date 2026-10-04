import { stripVTControlCharacters } from "node:util";
import { EventEmitter } from "node:events";
import {
  Box,
  render,
  Text,
  useBoxMetrics,
  useInput,
  type DOMElement,
} from "ink";
import type { UiMessage } from "ohbaby-sdk";
import { useRef, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../layout/app-shell.js";
import { LiveTail } from "./live-tail.js";
import { ThemeProvider } from "../../theme/index.js";
import { ReplayableTranscript } from "./replayable-transcript.js";

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
  readonly inputChunks: string[] = [];
  read(): string | null {
    return this.inputChunks.shift() ?? null;
  }
  pushInput(value: string): void {
    this.inputChunks.push(value);
    this.emit("readable");
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}

function mount(
  node: ReactElement,
  stdout: FakeStdout,
  incrementalRendering = true,
) {
  return render(node, {
    exitOnCtrlC: false,
    incrementalRendering,
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
        <ReplayableTranscript
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

describe("replayable committed output", () => {
  beforeEach(() => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("keeps long append-only history quiet and replaces a real correction once", async () => {
    const stdout = new FakeStdout();
    const long = "history line\n".repeat(40);
    const app = mount(history(long), stdout);
    try {
      await tick();
      const baseline = stdout.chunks.length;
      for (let i = 0; i < 3; i += 1) {
        app.rerender(history(long));
        await tick();
      }
      expect(stdout.chunks.slice(baseline).join("")).toBe("");
      app.rerender(history("CORRECTED history"));
      await tick();
      const correction = stdout.chunks.slice(baseline).join("");
      expect(correction.split(CLEAR_SCROLLBACK)).toHaveLength(2);
      expect(
        correction.slice(correction.lastIndexOf(CLEAR_SCROLLBACK)),
      ).toContain("CORRECTED history");
      const quiet = stdout.chunks.length;
      app.rerender(history("CORRECTED history"));
      await tick();
      expect(stdout.chunks.slice(quiet).join("")).toBe("");
      stdout.rows = 3;
      stdout.emit("resize");
      await tick();
      expect(stdout.chunks.slice(quiet).join("")).not.toContain("history line");
    } finally {
      app.unmount();
    }
  });
  it("measures all controls before assigning live rows and reacts to resize", async () => {
    let frameHeight = 0;
    function Frame({ controls }: { controls: number }): ReactElement {
      const ref = useRef<DOMElement>(null);
      const size = useBoxMetrics(ref);
      frameHeight = size.height;
      return (
        <Box ref={ref} flexDirection="column">
          <ReplayableTranscript
            items={[
              {
                id: "old",
                messageId: "old",
                message: message("history\n".repeat(40)),
                spacing: true,
              },
            ]}
          />
          <LiveTail message={message("live\n".repeat(40))} />
          <Text>
            {Array.from(
              { length: controls },
              (_, i) => `control ${String(i)}`,
            ).join("\n")}
          </Text>
        </Box>
      );
    }
    const view = (controls: number): ReactElement => (
      <ThemeProvider>
        <AppShell>
          <Frame controls={controls} />
        </AppShell>
      </ThemeProvider>
    );
    const stdout = new FakeStdout();
    const app = mount(view(6), stdout);
    try {
      await tick();
      await tick();
      expect(frameHeight).toBeLessThan(stdout.rows);
      const start = stdout.chunks.length;
      app.rerender(view(9));
      await tick();
      await tick();
      expect(frameHeight).toBeLessThan(stdout.rows);
      stdout.rows = 10;
      stdout.emit("resize");
      await tick();
      await tick();
      expect(frameHeight).toBeLessThan(stdout.rows);
      expect(stdout.chunks.slice(start).join("")).not.toContain(
        CLEAR_SCROLLBACK,
      );
    } finally {
      app.unmount();
    }
  });
  it("appends once and replays prepended history, session replacement and width changes without stale duplicates", async () => {
    const stdout = new FakeStdout();
    const items = (texts: string[]) =>
      texts.map((text) => ({
        id: text,
        messageId: text,
        message: { ...message(text), id: text },
        spacing: true,
      }));
    const view = (texts: string[], identity = "a"): ReactElement => (
      <ThemeProvider>
        <AppShell>
          <ReplayableTranscript identity={identity} items={items(texts)} />
          <Text>draft remains</Text>
        </AppShell>
      </ThemeProvider>
    );
    const app = mount(view(["SECOND"]), stdout);
    try {
      await tick();
      let baseline = stdout.chunks.length;
      app.rerender(view(["SECOND", "THIRD"]));
      await tick();
      const append = stdout.chunks.slice(baseline).join("");
      expect(append).toContain("THIRD");
      expect(append).not.toContain("SECOND");
      expect(append).not.toContain(CLEAR_SCROLLBACK);
      baseline = stdout.chunks.length;
      app.rerender(view(["FIRST", "SECOND", "THIRD"]));
      await tick();
      const prepend = stdout.chunks.slice(baseline).join("");
      expect(prepend.split(CLEAR_SCROLLBACK)).toHaveLength(2);
      const replay = prepend.slice(prepend.lastIndexOf(CLEAR_SCROLLBACK));
      expect(replay.indexOf("FIRST")).toBeLessThan(replay.indexOf("SECOND"));
      expect(replay.indexOf("SECOND")).toBeLessThan(replay.indexOf("THIRD"));
      expect(replay.split("SECOND")).toHaveLength(2);
      baseline = stdout.chunks.length;
      app.rerender(view(["NEW SESSION"], "b"));
      await tick();
      const switched = stdout.chunks.slice(baseline).join("");
      expect(switched.split(CLEAR_SCROLLBACK)).toHaveLength(2);
      expect(switched.slice(switched.lastIndexOf(CLEAR_SCROLLBACK))).toContain(
        "NEW SESSION",
      );
      expect(
        switched.slice(switched.lastIndexOf(CLEAR_SCROLLBACK)),
      ).not.toContain("SECOND");
      baseline = stdout.chunks.length;
      stdout.columns = 60;
      stdout.emit("resize");
      await tick();
      const resized = stdout.chunks.slice(baseline).join("");
      expect(resized.split(CLEAR_SCROLLBACK)).toHaveLength(2);
      expect(resized.slice(resized.lastIndexOf(CLEAR_SCROLLBACK))).toContain(
        "NEW SESSION",
      );
      expect(resized).not.toContain("SECOND");
    } finally {
      app.unmount();
    }
  });
  it.each([5, 15])(
    "never paints an oversized frame starting with %i controls",
    async (initialControls) => {
      const stdout = new FakeStdout();
      stdout.rows = 20;
      const view = (controls: number): ReactElement => (
        <ThemeProvider>
          <AppShell>
            <LiveTail message={message("live\n".repeat(40))} />
            <Text>
              {Array.from(
                { length: controls },
                (_, i) => `control ${String(i)}`,
              ).join("\n")}
            </Text>
          </AppShell>
        </ThemeProvider>
      );
      const app = mount(view(initialControls), stdout, false);
      try {
        await tick();
        await tick();
        app.rerender(view(15));
        await tick();
        await tick();
        const frames = stdout.chunks.filter((chunk) =>
          chunk.includes("control 14"),
        );
        expect(stdout.chunks.join("")).toContain("control 14");
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
          for (let i = 0; i < 15; i += 1)
            expect(frame).toContain(`control ${String(i)}`);
        }
        const heights = frames.map(
          (chunk) =>
            stripVTControlCharacters(chunk).trimEnd().split("\n").length,
        );
        expect(Math.max(...heights)).toBeLessThan(stdout.rows);
      } finally {
        app.unmount();
      }
    },
  );
});

it("Ctrl+O replays a changed tool projection exactly once, preserves input state and stays quiet for identical projections", async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  function Scene({
    hasTool,
    tickValue = 0,
  }: {
    hasTool: boolean;
    tickValue?: number;
  }): ReactElement {
    const [expanded, setExpanded] = useState(false);
    const [draft, setDraft] = useState("draft");
    useInput((input, key) => {
      if (key.ctrl && input === "o") setExpanded((value) => !value);
      else if (!key.ctrl) setDraft((value) => `${value}${input}`);
    });
    const tool: UiMessage = {
      ...message(""),
      parts: [
        {
          type: "tool-call",
          call: {
            id: "bash-1",
            name: "bash",
            input: { command: "test" },
            status: "completed",
          },
        },
        {
          type: "tool-result",
          result: {
            callId: "bash-1",
            output: Array.from(
              { length: 30 },
              (_, i) => `TOOL-LINE-${String(i).padStart(2, "0")}`,
            ).join("\n"),
          },
        },
      ],
    };
    return (
      <ThemeProvider>
        <AppShell>
          <ReplayableTranscript
            toolsExpanded={expanded}
            items={[
              {
                id: "history",
                messageId: "history",
                message: hasTool ? tool : message("UNCHANGED"),
                spacing: true,
              },
            ]}
          />
          <Text>
            {draft} cursor=5 activity={tickValue}
          </Text>
        </AppShell>
      </ThemeProvider>
    );
  }
  const app = render(<Scene hasTool={false} />, {
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const press = () => {
    stdin.pushInput("\u000f");
  };
  try {
    await tick();
    let baseline = stdout.chunks.length;
    press();
    await tick();
    expect(stdout.chunks.slice(baseline).join("")).not.toContain(
      CLEAR_SCROLLBACK,
    );
    app.rerender(<Scene hasTool />);
    await tick();
    expect(stdout.chunks.join("")).toContain("TOOL-LINE-00");
    baseline = stdout.chunks.length;
    press();
    await tick();
    let switched = stdout.chunks.slice(baseline).join("");
    expect(switched.split(CLEAR_SCROLLBACK)).toHaveLength(2);
    expect(
      switched.slice(switched.lastIndexOf(CLEAR_SCROLLBACK)),
    ).not.toContain("TOOL-LINE-00");
    expect(switched).toContain("draft cursor=5");
    baseline = stdout.chunks.length;
    press();
    await tick();
    switched = stdout.chunks.slice(baseline).join("");
    expect(switched.split(CLEAR_SCROLLBACK)).toHaveLength(2);
    expect(switched).toContain("TOOL-LINE-00");
    expect(switched.slice(0, switched.indexOf(CLEAR_SCROLLBACK))).not.toContain(
      "TOOL-LINE-",
    );
    baseline = stdout.chunks.length;
    app.rerender(<Scene hasTool tickValue={1} />);
    await tick();
    const ordinary = stdout.chunks.slice(baseline).join("");
    expect(ordinary).not.toContain(CLEAR_SCROLLBACK);
    expect(ordinary).not.toContain("TOOL-LINE-00");
    expect(ordinary).toContain("1");
  } finally {
    app.unmount();
  }
});
