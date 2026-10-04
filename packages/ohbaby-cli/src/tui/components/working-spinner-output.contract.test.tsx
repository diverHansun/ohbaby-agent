import { EventEmitter } from "node:events";
import { render } from "ink";
import type { UiModelRequest } from "ohbaby-sdk";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTheme, ThemeProvider } from "../theme/index.js";
import { DurationSampleContext } from "./execution-duration.js";
import { WorkingSpinner } from "./working-spinner.js";

// Ink's color support is detected when its modules load, before test callbacks.
const originalForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  return previous;
});
afterAll(() => {
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
});
afterEach(() => vi.unstubAllEnvs());

class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 24;
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
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("working indicator real Ink stdout", () => {
  it.each([false, true])(
    "bounds settled writes and stops hidden timers (noAnimation=%s)",
    async (noAnimation) => {
      vi.stubEnv("OHBABY_TUI_NO_ANIM", noAnimation ? "1" : "0");
      const stdout = new FakeStdout();
      const sample = { serverNow: 2000, receivedAt: performance.now() };
      const request: UiModelRequest = {
        requestId: "request",
        runId: "run",
        messageId: "message",
        purpose: "agent-step",
        step: 0,
        attempt: 0,
        startedAt: 1000,
        outcome: "running",
      };
      const view = (
        state: "waiting" | "hidden" | "ended",
      ): React.ReactElement => (
        <ThemeProvider theme={createTheme("dark", 3)}>
          <DurationSampleContext.Provider value={sample}>
            <WorkingSpinner
              runtime={
                state === "ended"
                  ? { kind: "idle" }
                  : {
                      kind: "running",
                      runId: "run",
                      title: "Checking the implementation",
                    }
              }
              modelActivity={
                state === "hidden" ? { ...request, firstTextAt: 3000 } : request
              }
            />
          </DurationSampleContext.Provider>
        </ThemeProvider>
      );
      const app = render(view("waiting"), {
        exitOnCtrlC: false,
        incrementalRendering: true,
        patchConsole: false,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      });
      let unmounted = false;
      try {
        await wait(250);
        expect(stdout.chunks.join("")).toContain("\u001b[38;2;");
        const start = stdout.chunks.length;
        await wait(1000);
        const writes = stdout.chunks.slice(start);
        const bytes = Buffer.byteLength(writes.join(""));
        expect(writes.length).toBeGreaterThan(0);
        // Ink brackets each content patch in synchronized-output control writes.
        // Count both raw write calls and actual content updates for comparison.
        const contentWrites = writes.filter(
          (chunk) => chunk !== "\u001b[?2026h" && chunk !== "\u001b[?2026l",
        );
        // 20 animation frames, plus one elapsed-time update and one boundary
        // frame. A faster clock must not add another independent pulse timer.
        const maxContentUpdates = noAnimation ? 2 : 22;
        expect(contentWrites.length).toBeLessThanOrEqual(maxContentUpdates);
        expect(writes.length).toBeLessThanOrEqual(maxContentUpdates * 3);
        // Budget the actual colored row, not just the number of callbacks:
        // no patch exceeds 512 bytes and this fixture stays under 8 KiB/s.
        const largestPatchBytes = Math.max(
          ...contentWrites.map((chunk) => Buffer.byteLength(chunk)),
        );
        expect(largestPatchBytes).toBeLessThanOrEqual(512);
        expect(bytes).toBeLessThanOrEqual(noAnimation ? 256 : 8 * 1024);
        // Enabled shimmer must actually update; a colorless no-op is not evidence.
        if (!noAnimation) expect(contentWrites.length).toBeGreaterThan(2);
        expect(bytes).toBeGreaterThan(0);
        expect(writes.join("")).not.toContain("\u001b[3J");
        expect(writes.join("")).not.toContain("\u001b[2J");

        app.rerender(view("hidden"));
        await wait(200);
        const hidden = stdout.chunks.length;
        await wait(1100);
        expect(stdout.chunks.length).toBe(hidden);
        app.rerender(view("waiting"));
        await wait(200);
        app.rerender(view("ended"));
        await wait(200);
        const ended = stdout.chunks.length;
        await wait(1100);
        expect(stdout.chunks.length).toBe(ended);
        app.rerender(view("waiting"));
        await wait(200);
        app.unmount();
        unmounted = true;
        await wait(100); // Exclude the expected unmount cursor restoration.
        const unmount = stdout.chunks.length;
        await wait(1100);
        expect(stdout.chunks.length).toBe(unmount);
        process.stdout.write(
          "T10 actual Ink stdout " +
            JSON.stringify({
              noAnimation,
              windowMs: 1000,
              writes: writes.length,
              contentUpdates: contentWrites.length,
              bytes,
              largestPatchBytes,
              hiddenWrites: 0,
              endedWrites: 0,
              postUnmountWrites: 0,
            }) +
            "\n",
        );
      } finally {
        if (!unmounted) app.unmount();
      }
    },
  );
});
