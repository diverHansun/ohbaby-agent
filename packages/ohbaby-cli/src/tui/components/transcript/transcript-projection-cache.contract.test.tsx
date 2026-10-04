import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import type { UiMessage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../../layout/app-shell.js";
import * as messageRows from "../message/message-row.js";
import { ThemeProvider } from "../../theme/index.js";
import { ReplayableTranscript } from "./replayable-transcript.js";

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

function mount(
  node: ReactElement,
  stdout: FakeStdout,
  incrementalRendering = true,
): ReturnType<typeof render> {
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

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

describe("committed projection cost", () => {
  it("reuses immutable message projections while still detecting replacements", async () => {
    const project = vi.spyOn(messageRows, "renderMessageParts");
    const stringify = vi.spyOn(JSON, "stringify");
    const stdout = new FakeStdout();
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message(`**history ${String(index)}**\nbody`),
      id: String(index),
    }));
    const node = (items: UiMessage[]): ReactElement => (
      <ThemeProvider>
        <AppShell>
          <ReplayableTranscript
            items={items.map((message) => ({
              id: message.id,
              messageId: message.id,
              message,
              spacing: true,
            }))}
          />
          <Text>input</Text>
        </AppShell>
      </ThemeProvider>
    );
    const app = mount(node(messages), stdout);
    try {
      await tick();
      const initialCalls = project.mock.calls.length;
      const initialSerializations = stringify.mock.calls.length;
      const initialWrites = stdout.chunks.length;
      for (let i = 0; i < 3; i++) {
        app.rerender(node([...messages]));
        await tick();
      }
      expect(project.mock.calls.length).toBe(initialCalls);
      expect(
        stringify.mock.calls
          .slice(initialSerializations)
          .filter(
            ([value]) => value && typeof value === "object" && "part" in value,
          ),
      ).toHaveLength(0);
      expect(stdout.chunks.slice(initialWrites).join("")).toBe("");
      const changed = [...messages];
      changed[0] = { ...message("corrected history"), id: "0" };
      app.rerender(node(changed));
      await tick();
      expect(project.mock.calls.length).toBeGreaterThan(initialCalls);
      expect(stdout.chunks.slice(initialWrites).join("")).toContain(
        "corrected history",
      );
    } finally {
      app.unmount();
      project.mockRestore();
      stringify.mockRestore();
    }
  });
});
