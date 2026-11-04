import { afterEach, expect, it, vi } from "vitest";
import { parseMacosSessions } from "./macos-session.js";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});
it("distinguishes exited PIDs from failed inspection and rejects incomplete replies", () => {
  expect([...parseMacosSessions("[[10,10,0],[11,-1,3]]", [10, 11])]).toEqual([
    [10, 10],
  ]);
  expect(() => parseMacosSessions("[[10,-1,1]]", [10])).toThrow();
  expect(() => parseMacosSessions("[]", [10])).toThrow();
  expect(() => parseMacosSessions("[[12,10,0]]", [10])).toThrow();
});
it("rejects a failed system capability probe and retries it on the next call", async () => {
  let attempts = 0;
  vi.doMock("node:child_process", () => ({
    execFile: (...args: unknown[]): void => {
      attempts += 1;
      const callback = args[args.length - 1] as (
        error: Error | null,
        result?: { stdout: string },
      ) => void;
      if (attempts === 1) callback(new Error("osascript timed out"));
      else
        callback(null, {
          stdout: JSON.stringify([[process.pid, process.pid, 0]]),
        });
    },
  }));
  const { ensureMacosSessionSupport } = await import("./macos-session.js");
  await expect(ensureMacosSessionSupport()).rejects.toThrow(
    "osascript timed out",
  );
  await expect(ensureMacosSessionSupport()).resolves.toBeUndefined();
  await expect(ensureMacosSessionSupport()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});
