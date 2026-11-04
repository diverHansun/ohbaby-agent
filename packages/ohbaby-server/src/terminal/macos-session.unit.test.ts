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
it("retains a failed system capability probe instead of silently falling back", async () => {
  let attempts = 0;
  vi.doMock("node:child_process", () => ({
    execFile: (...args: unknown[]): void => {
      attempts += 1;
      const callback = args[args.length - 1] as (error: Error) => void;
      callback(new Error("osascript disabled"));
    },
  }));
  const { ensureMacosSessionSupport } = await import("./macos-session.js");
  await expect(ensureMacosSessionSupport()).rejects.toThrow(
    "osascript disabled",
  );
  await expect(ensureMacosSessionSupport()).rejects.toThrow(
    "osascript disabled",
  );
  expect(attempts).toBe(1);
});
