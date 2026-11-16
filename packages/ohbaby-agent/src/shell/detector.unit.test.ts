import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAcceptableShell } from "./detector.js";

afterEach(() => vi.restoreAllMocks());

describe("native shell selection", () => {
  it.each([true, false])(
    "honors an explicit Windows existence check returning %s",
    (available) => {
      const shell = "C:\\custom\\pwsh.exe";
      const existsSync = vi.fn(() => available);
      const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
        throw new Error("injected check must own the lookup");
      });
      const resolve = (): string =>
        resolveAcceptableShell({
          platform: "win32",
          env: { SHELL: shell },
          existsSync,
        });
      if (available) expect(resolve()).toBe(shell);
      else expect(resolve).toThrow("unavailable");
      expect(existsSync).toHaveBeenCalledWith(shell);
      expect(lstat).not.toHaveBeenCalled();
    },
  );
  it("accepts a Windows explicit shell file", () => {
    const shell = "C:\\PowerShell\\pwsh.exe";
    const entry = fs.lstatSync(process.execPath);
    vi.spyOn(fs, "lstatSync").mockReturnValue(entry);
    expect(
      resolveAcceptableShell({ platform: "win32", env: { SHELL: shell } }),
    ).toBe(shell);
  });
  it("accepts a Windows shell alias even when following its target is denied", () => {
    const alias = "C:\\Users\\test\\WindowsApps\\pwsh.exe";
    const entry = fs.lstatSync(process.execPath);
    vi.spyOn(entry, "isFile").mockReturnValue(false);
    vi.spyOn(entry, "isSymbolicLink").mockReturnValue(true);
    vi.spyOn(fs, "lstatSync").mockReturnValue(entry);
    expect(
      resolveAcceptableShell({
        platform: "win32",
        env: { SHELL: alias },
      }),
    ).toBe(alias);
  });

  it("rejects a Windows directory named like a shell", () => {
    const directory = "C:\\not-a-shell\\pwsh.exe";
    const entry = fs.lstatSync(process.cwd());
    vi.spyOn(fs, "lstatSync").mockReturnValue(entry);
    expect(() =>
      resolveAcceptableShell({
        platform: "win32",
        env: { SHELL: directory },
      }),
    ).toThrow("unavailable");
  });

  it("rejects a missing Windows explicit shell without falling back", () => {
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() =>
      resolveAcceptableShell({
        platform: "win32",
        env: { SHELL: "C:\\missing\\pwsh.exe" },
        which: () => "powershell.exe",
      }),
    ).toThrow("unavailable");
  });
  it("prefers Windows PowerShell defaults instead of automatically detecting Git Bash", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(
      resolveAcceptableShell({
        platform: "win32",
        env: {},
        existsSync: () => false,
        which: (name) =>
          name === "pwsh.exe" ? pwsh : "C:\\Program Files\\Git\\cmd\\git.exe",
      }),
    ).toBe(pwsh);
    expect(
      resolveAcceptableShell({
        platform: "win32",
        env: { SHELL: "/usr/bin/bash", SystemRoot: "C:\\Windows" },
        existsSync: (candidate) => candidate.endsWith("powershell.exe"),
        which: () => undefined,
      }),
    ).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
  it("rejects missing supported explicit paths instead of changing shells", () => {
    expect(() =>
      resolveAcceptableShell({
        platform: "linux",
        env: { SHELL: "/missing/bash" },
        existsSync: () => false,
        which: () => "/bin/bash",
      }),
    ).toThrow("unavailable");
  });
  it("falls back from unsupported preferences and from absent Linux bash", () => {
    expect(
      resolveAcceptableShell({
        platform: "linux",
        env: { SHELL: "/usr/bin/fish" },
        existsSync: (candidate) => candidate === "/bin/sh",
        which: () => undefined,
      }),
    ).toBe("/bin/sh");
    expect(
      resolveAcceptableShell({
        platform: "darwin",
        env: {},
        existsSync: (candidate) => candidate === "/bin/zsh",
        which: () => undefined,
      }),
    ).toBe("/bin/zsh");
  });
  it("rejects the Windows WSL bash launcher", () => {
    expect(() =>
      resolveAcceptableShell({
        platform: "win32",
        env: { SHELL: "bash" },
        existsSync: () => false,
        which: () => "C:\\Windows\\System32\\bash.exe",
      }),
    ).toThrow("WSL");
  });
});
