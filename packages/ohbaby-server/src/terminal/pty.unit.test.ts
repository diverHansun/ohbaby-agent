import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@lydell/node-pty");
  vi.resetModules();
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
