import { EventEmitter } from "node:events";
import { render } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../layout/app-shell.js";
import { ThemeProvider } from "../../theme/index.js";
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
    } finally {
      app.unmount();
    }
  });
});

function viewport(live: UiMessage): ReactElement {
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
          ]}
          liveMessage={live}
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
