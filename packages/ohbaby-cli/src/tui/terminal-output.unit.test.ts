import { describe, expect, it, vi } from "vitest";
import { createFrameCoalescingStdout } from "./terminal-output.js";

function fakeStdout(): {
  readonly stream: NodeJS.WriteStream;
  readonly writes: string[];
} {
  const writes: string[] = [];
  const stream = {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: vi.fn((chunk: string, ...rest: unknown[]) => {
      writes.push(chunk);
      const done = rest.find((value) => typeof value === "function") as
        | (() => void)
        | undefined;
      done?.();
      return true;
    }),
  };
  return { stream: stream as unknown as NodeJS.WriteStream, writes };
}

describe("createFrameCoalescingStdout", () => {
  it("joins a synchronized frame update into a single write", () => {
    const { stream, writes } = fakeStdout();
    const out = createFrameCoalescingStdout(stream);
    out.write("\u001b[?2026h");
    out.write("erase");
    out.write("static\n");
    out.write("frame");
    out.write("\u001b[?2026l");
    expect(writes).toEqual(["\u001b[?2026herasestatic\nframe\u001b[?2026l"]);
  });

  it("passes other writes and callbacks through synchronously", () => {
    const { stream, writes } = fakeStdout();
    const out = createFrameCoalescingStdout(stream);
    const done = vi.fn();
    out.write("cursor-show");
    out.write("", done);
    expect(writes).toEqual(["cursor-show", ""]);
    expect(done).toHaveBeenCalledOnce();
    expect(out.columns).toBe(80);
  });

  it("returns downstream backpressure when a complete frame is flushed", () => {
    const { stream } = fakeStdout();
    vi.spyOn(stream, "write").mockReturnValue(false);
    const out = createFrameCoalescingStdout(stream);
    out.write("\u001b[?2026h");
    out.write("frame");
    expect(out.write("\u001b[?2026l")).toBe(false);
  });

  it("never holds a frame whose end marker is missing past the task", async () => {
    const { stream, writes } = fakeStdout();
    const out = createFrameCoalescingStdout(stream);
    out.write("\u001b[?2026h");
    out.write("partial");
    expect(writes).toEqual([]);
    await Promise.resolve();
    expect(writes).toEqual(["\u001b[?2026hpartial"]);
  });

  it("preserves every frame byte, including erase and cursor positioning", () => {
    const { stream, writes } = fakeStdout();
    const out = createFrameCoalescingStdout(stream);
    const parts = [
      "\u001b[?2026h",
      "\u001b[2K\u001b[1A\u001b[2K\u001b[G",
      "\u001b[48;2;12;34;56m中文 é\u001b[0m\n",
      "\u001b[3A\u001b[5G",
      "\u001b[?2026l",
    ];
    for (const part of parts) out.write(part);
    expect(writes).toEqual([parts.join("")]);
  });

  it("flushes pending bytes before forwarding a callback barrier", () => {
    const { stream, writes } = fakeStdout();
    const out = createFrameCoalescingStdout(stream);
    const done = vi.fn(() => {
      expect(writes).toEqual(["\u001b[?2026hpartial", "barrier"]);
    });
    out.write("\u001b[?2026h");
    out.write("partial");
    out.write("barrier", done);
    expect(done).toHaveBeenCalledOnce();
  });
});
