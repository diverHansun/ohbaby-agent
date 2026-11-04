import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@lydell/node-pty");
  vi.doUnmock("./macos-session.js");
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("loads the native dependency only on creation and retains a failed load for later requests", async () => {
  let attempts = 0;
  const failure = new Error("Native PTY binary missing");
  vi.doMock("@lydell/node-pty", () => {
    attempts += 1;
    throw failure;
  });
  const { createTerminalPty } = await import("./pty.js");
  expect(attempts).toBe(0);
  const options = { directory: "/tmp", cols: 80, rows: 24 };
  await expect(createTerminalPty(options)).rejects.toMatchObject({
    cause: failure,
  });
  await expect(createTerminalPty(options)).rejects.toMatchObject({
    cause: failure,
  });
  expect(attempts).toBe(1);
});

it("rejects a missing macOS inspection capability before allocating a shell", async () => {
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "darwin" } }),
  );
  const spawn = vi.fn();
  vi.doMock("@lydell/node-pty", () => ({ spawn }));
  vi.doMock("./macos-session.js", () => ({
    ensureMacosSessionSupport: (): Promise<void> =>
      Promise.reject(new Error("system inspection disabled")),
  }));
  const { createTerminalPty } = await import("./pty.js");
  await expect(
    createTerminalPty({ directory: "/tmp", cols: 80, rows: 24 }),
  ).rejects.toThrow("system inspection disabled");
  expect(spawn).not.toHaveBeenCalled();
});
