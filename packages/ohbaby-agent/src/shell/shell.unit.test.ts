import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  Shell,
  deriveGitBashPath,
  isBlacklistedShell,
  killTreeWithPlatform,
  resolveAcceptableShell,
  resolvePreferredShell,
} from "./index.js";

describe("shell detection", () => {
  it("uses SHELL as the preferred shell without blacklist filtering", () => {
    expect(
      resolvePreferredShell({
        env: { SHELL: "/usr/bin/fish" },
        platform: "linux",
      }),
    ).toBe("/usr/bin/fish");
  });

  it("filters blacklisted shells for acceptable shell selection", () => {
    expect(
      resolveAcceptableShell({
        env: { SHELL: "/usr/bin/fish" },
        existsSync: () => false,
        platform: "linux",
        which: () => undefined,
      }),
    ).toBe("/bin/bash");
    expect(isBlacklistedShell("C:\\tools\\Nu.exe", "win32")).toBe(true);
    expect(isBlacklistedShell("/bin/bash", "linux")).toBe(false);
  });

  it("detects Windows Git Bash from a git.exe path before falling back to COMSPEC", () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

    expect(deriveGitBashPath(git)).toBe(bash);
    expect(
      resolveAcceptableShell({
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", SHELL: "/usr/bin/bash" },
        existsSync: (candidate) => candidate === bash,
        platform: "win32",
        which: (command) => (command === "git" ? git : undefined),
      }),
    ).toBe(bash);
    expect(
      resolveAcceptableShell({
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        existsSync: () => false,
        platform: "win32",
        which: () => undefined,
      }),
    ).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("falls back to platform defaults when SHELL is empty", () => {
    expect(resolvePreferredShell({ env: {}, platform: "darwin" })).toBe(
      "/bin/zsh",
    );
    expect(
      resolveAcceptableShell({
        env: {},
        existsSync: () => false,
        platform: "linux",
        which: () => undefined,
      }),
    ).toBe("/bin/bash");
  });

  it("exposes cached namespace helpers", () => {
    expect(Shell.preferred()).toBeTypeOf("string");
    expect(Shell.acceptable()).toBeTypeOf("string");
  });
});

describe("killTree", () => {
  it("does nothing for pid-less processes", async () => {
    const spawnTaskkill = vi.fn();
    const killProcess = vi.fn();

    await killTreeWithPlatform(
      { pid: undefined },
      {
        exited: () => false,
        killProcess,
        platform: "linux",
        spawnTaskkill,
      },
    );

    expect(killProcess).not.toHaveBeenCalled();
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("uses taskkill for Windows process trees", async () => {
    const spawnTaskkill = vi.fn(() => Promise.resolve());

    await killTreeWithPlatform(
      { pid: 123 },
      {
        exited: () => false,
        killProcess: vi.fn(),
        platform: "win32",
        spawnTaskkill,
      },
    );

    expect(spawnTaskkill).toHaveBeenCalledWith(123);
  });

  it("skips taskkill for exited Windows process trees", async () => {
    const spawnTaskkill = vi.fn();

    await killTreeWithPlatform(
      { pid: 123 },
      {
        exited: () => true,
        killProcess: vi.fn(),
        platform: "win32",
        spawnTaskkill,
      },
    );

    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM then SIGKILL to Unix process groups when still running", async () => {
    const signals: string[] = [];

    await killTreeWithPlatform(
      { pid: 123 },
      {
        delay: () => Promise.resolve(),
        exited: () => false,
        killProcess(pid, signal): void {
          signals.push(`${String(pid)}:${signal}`);
        },
        platform: "linux",
        spawnTaskkill: vi.fn(),
      },
    );

    expect(signals).toEqual(["-123:SIGTERM", "-123:SIGKILL"]);
  });

  it("still best-effort kills Unix process groups after the parent exits", async () => {
    const signals: string[] = [];

    await killTreeWithPlatform(
      { pid: 123 },
      {
        delay: () => Promise.resolve(),
        exited: () => true,
        killProcess(pid, signal): void {
          signals.push(`${String(pid)}:${signal}`);
        },
        platform: "linux",
        spawnTaskkill: vi.fn(),
      },
    );

    expect(signals).toEqual(["-123:SIGTERM", "-123:SIGKILL"]);
  });

  it("does not SIGKILL a fallback positive pid after it exits", async () => {
    const signals: string[] = [];
    let exited = false;

    await killTreeWithPlatform(
      { pid: 123 },
      {
        delay: () => {
          exited = true;
          return Promise.resolve();
        },
        exited: () => exited,
        killProcess(pid, signal): void {
          signals.push(`${String(pid)}:${signal}`);
          if (pid < 0) {
            throw new Error("process group unavailable");
          }
        },
        platform: "linux",
        spawnTaskkill: vi.fn(),
      },
    );

    expect(signals).toEqual(["-123:SIGTERM", "123:SIGTERM"]);
  });

  it("ignores kill errors from stale processes", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.defineProperty(child, "pid", { value: 123 });

    await expect(
      Shell.killTree(child, { exited: () => true }),
    ).resolves.toBeUndefined();
  });
});
