import { describe, expect, it } from "vitest";
import { resolveAcceptableShell } from "./detector.js";

describe("native shell selection", () => {
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
