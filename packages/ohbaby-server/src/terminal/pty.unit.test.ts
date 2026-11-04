import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@lydell/node-pty");
  vi.doUnmock("./macos-session.js");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:path");
  vi.resetModules();
  vi.unstubAllGlobals();
});

it.each(["Path", "PATH", "path"])(
  "finds a Windows shell using %s without duplicating the inherited path key",
  async (pathKey) => {
    vi.stubGlobal(
      "process",
      Object.create(process, { platform: { value: "win32" } }),
    );
    vi.doMock("node:path", async () => {
      const actual =
        await vi.importActual<typeof import("node:path")>("node:path");
      return { ...actual, ...actual.win32 };
    });
    vi.doMock("node:fs", () => ({
      constants: { X_OK: 1 },
      accessSync: (file: string): void => {
        if (file !== "C:\\Tools\\PowerShell\\pwsh.exe")
          throw new Error("Executable not found");
      },
      statSync: (): { isFile(): boolean } => ({ isFile: (): boolean => true }),
    }));
    const dispose = (): void => undefined;
    const spawn = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: { env: NodeJS.ProcessEnv },
      ) => ({
        pid: 123,
        onData: (): { dispose(): void } => ({ dispose }),
        onExit: (): { dispose(): void } => ({ dispose }),
      }),
    );
    vi.doMock("@lydell/node-pty", () => ({ spawn }));
    const { createTerminalPty } = await import("./pty.js");
    const env = { [pathKey]: "C:\\Missing;C:\\Tools\\PowerShell" };
    const result = await createTerminalPty({
      directory: "C:\\work",
      cols: 80,
      rows: 24,
      env,
    });
    expect(result.shell).toBe("pwsh");
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(["pwsh.exe", []]);
    const options = spawn.mock.calls[0][2];
    expect(options.env[pathKey]).toBe(env[pathKey]);
    expect(
      Object.keys(options.env).filter((key) => key.toUpperCase() === "PATH"),
    ).toEqual([pathKey]);
    expect(env).toEqual({ [pathKey]: "C:\\Missing;C:\\Tools\\PowerShell" });
  },
);

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
