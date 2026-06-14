import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("Windows shell detection process launching", () => {
  it("hides the fallback which/where lookup window", async () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const execFileSync = vi.fn((..._args: unknown[]) =>
      Buffer.from(`${git}\r\n`, "utf8"),
    );
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, execFileSync };
    });
    const { resolveAcceptableShell } = await import("./detector.js");

    expect(
      resolveAcceptableShell({
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        existsSync: (candidate) => candidate === bash,
        platform: "win32",
      }),
    ).toBe(bash);

    expect(execFileSync.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
