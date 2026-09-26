import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  Shell,
  deriveGitBashPath,
  isBlacklistedShell,
  killTreeWithPlatform,
  probeProcessTree,
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
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          SHELL: "/usr/bin/bash",
        },
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

  it("honors an explicitly configured existing Windows PowerShell shell", () => {
    const powershell =
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    expect(
      resolveAcceptableShell({
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", SHELL: powershell },
        existsSync: (candidate) => candidate === powershell,
        platform: "win32",
        which: () => undefined,
      }),
    ).toBe(powershell);
    expect(
      resolveAcceptableShell({
        env: { SHELL: "pwsh.exe" },
        existsSync: () => false,
        platform: "win32",
        which: (command) =>
          command === "pwsh.exe"
            ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
            : undefined,
      }),
    ).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("ignores unsupported Windows SHELL values before fallback selection", () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

    expect(
      resolveAcceptableShell({
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          SHELL: "C:\\Tools\\fish.exe",
        },
        existsSync: (candidate) =>
          candidate === "C:\\Tools\\fish.exe" || candidate === bash,
        platform: "win32",
        which: (command) => (command === "git" ? git : undefined),
      }),
    ).toBe(bash);
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
  it("does not claim a pid-less process stopped", async () => {
    const result = await killTreeWithPlatform({ pid: undefined });
    expect(result).toEqual({ status: "unconfirmed", reason: "missing-pid" });
  });

  it("confirms an absent group without signaling a potentially reused leader", async () => {
    const killProcess = vi.fn();
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        probeGroup: () => "stopped",
        killProcess,
      },
    );
    expect(result.status).toBe("confirmed");
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("does not escalate after TERM has stopped the entire group", async () => {
    let running = true;
    const signals: string[] = [];
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        probeGroup: () => (running ? "running" : "stopped"),
        delay: () => {
          running = false;
          return Promise.resolve();
        },
        killProcess: (pid, signal) => {
          signals.push(`${String(pid)}:${signal}`);
        },
      },
    );
    expect(result.status).toBe("confirmed");
    expect(signals).toEqual(["-123:SIGTERM"]);
  });

  it("escalates after 200ms even when the leader exited, then observes up to 1000ms", async () => {
    let elapsed = 0;
    const signals: string[] = [];
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        exited: () => true,
        probeGroup: () => "running",
        delay: (ms) => {
          elapsed += ms;
          return Promise.resolve();
        },
        killProcess: (pid, signal) => {
          signals.push(`${String(elapsed)}:${String(pid)}:${signal}`);
        },
      },
    );
    expect(result).toMatchObject({
      status: "unconfirmed",
      reason: "observation-expired",
    });
    expect(signals).toEqual(["0:-123:SIGTERM", "200:-123:SIGKILL"]);
    expect(elapsed).toBe(1200);
  });

  it("confirms group absence following KILL without waiting for output close", async () => {
    let killed = false;
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        exited: () => false,
        probeGroup: () => (killed ? "stopped" : "running"),
        delay: () => Promise.resolve(),
        killProcess: (_pid, signal) => {
          killed = signal === "SIGKILL";
        },
      },
    );
    expect(result.status).toBe("confirmed");
  });

  it("preserves uncertainty on a failed liveness probe without signaling", async () => {
    const killProcess = vi.fn();
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        probeGroup: () => {
          throw new Error("EPERM");
        },
        killProcess,
      },
    );
    expect(result).toMatchObject({
      status: "unconfirmed",
      reason: "probe-failed",
    });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("never substitutes a positive PID when group termination fails", async () => {
    const signals: number[] = [];
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "linux",
        probeGroup: () => "running",
        killProcess: (pid) => {
          signals.push(pid);
          throw new Error("EPERM");
        },
      },
    );
    expect(result).toMatchObject({
      status: "unconfirmed",
      reason: "termination-failed",
    });
    expect(signals).toEqual([-123]);
  });

  it("never taskkills a known exited Windows leader whose PID may be reused", async () => {
    const spawnTaskkill = vi.fn(() => Promise.resolve());
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "win32",
        exited: () => true,
        spawnTaskkill,
      },
    );
    expect(result.status).toBe("unconfirmed");
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("confirms a previously terminated Windows owner without signaling again", async () => {
    const spawnTaskkill = vi.fn(() => Promise.resolve());
    expect(
      await killTreeWithPlatform(
        { pid: 123 },
        {
          platform: "win32",
          exited: () => true,
          terminationSucceeded: true,
          spawnTaskkill,
        },
      ),
    ).toEqual({ status: "confirmed", terminationSucceeded: true });
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("requires successful taskkill and owned exit evidence on Windows", async () => {
    let exited = false;
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "win32",
        exited: () => exited,
        spawnTaskkill: () => {
          exited = true;
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ status: "confirmed", terminationSucceeded: true });
  });

  it("bounds Windows observation when taskkill succeeds but owned exit is missing", async () => {
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "win32",
        exited: () => false,
        spawnTaskkill: () => Promise.resolve(),
        observationMs: 10,
      },
    );
    expect(result).toEqual({
      status: "unconfirmed",
      reason: "observation-expired",
      terminationSucceeded: true,
    });
  });

  it("bounds observation even when the Windows terminator never settles", async () => {
    const result = await killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "win32",
        exited: () => false,
        spawnTaskkill: () =>
          new Promise(() => {
            /* Deliberately never settles. */
          }),
        observationMs: 10,
      },
    );
    expect(result.status).toBe("unconfirmed");
  });
});

describe("process cleanup evidence", () => {
  it("starts Windows termination synchronously before returning control", async () => {
    let requested = false;
    const pending = killTreeWithPlatform(
      { pid: 123 },
      {
        platform: "win32",
        exited: () => requested,
        spawnTaskkill: () => {
          requested = true;
          return Promise.resolve();
        },
      },
    );
    expect(requested).toBe(true);
    expect((await pending).status).toBe("confirmed");
  });
  it("never resends signals for the same owned child after an unconfirmed observation", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = {
      pid: 123,
      exitCode: null,
      signalCode: null,
    } as ChildProcess;
    try {
      const pending = Shell.killTree(child);
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe("unconfirmed");
      const callCount = kill.mock.calls.length;
      const repeated = Shell.killTree(child);
      await vi.runAllTimersAsync();
      expect(await repeated).toEqual(await pending);
      expect(kill).toHaveBeenCalledTimes(callCount);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("distinguishes actual group absence from permission/probe failure", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      kill.mockImplementation(() => {
        throw Object.assign(new Error(), { code: "EPERM" });
      });
      expect(probeProcessTree({ pid: 123 }, { platform: "linux" })).toBe(
        "unknown",
      );
      kill.mockImplementation(() => {
        throw Object.assign(new Error(), { code: "ESRCH" });
      });
      expect(probeProcessTree({ pid: 123 }, { platform: "linux" })).toBe(
        "stopped",
      );
    } finally {
      kill.mockRestore();
    }
  });

  it("uses a late Windows exit only with retained taskkill success evidence", () => {
    expect(
      probeProcessTree({ pid: 123 }, { platform: "win32", exited: () => true }),
    ).toBe("unknown");
    expect(
      probeProcessTree(
        { pid: 123 },
        { platform: "win32", exited: () => true, terminationSucceeded: true },
      ),
    ).toBe("stopped");
  });
});

describe("bounded POSIX probe recovery", () => {
  it.each(["SIGTERM", "SIGKILL"] as const)(
    "confirms transient unknown after %s within the original observation window",
    async (recoverAfter) => {
      const signals: NodeJS.Signals[] = [];
      let elapsed = 0;
      let signalledAt = 0;
      vi.useFakeTimers();
      try {
        const result = await killTreeWithPlatform(
          { pid: 123 },
          {
            platform: "linux",
            killProcess: (_pid, signal) => {
              signals.push(signal);
              signalledAt = elapsed;
            },
            probeGroup: () => {
              if (signals.at(-1) !== recoverAfter) return "running";
              return elapsed > signalledAt ? "stopped" : "unknown";
            },
            delay: (ms) => {
              elapsed += ms;
              return Promise.resolve();
            },
          },
        );
        expect(result).toEqual({ status: "confirmed" });
        expect(signals).toEqual(
          recoverAfter === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
        );
        expect(elapsed).toBe(recoverAfter === "SIGTERM" ? 20 : 220);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "expires a persistently unknown probe after %s without renewed signals or budget",
    async (failAfter) => {
      const signals: NodeJS.Signals[] = [];
      let elapsed = 0;
      vi.useFakeTimers();
      try {
        const result = await killTreeWithPlatform(
          { pid: 123 },
          {
            platform: "linux",
            killProcess: (_pid, signal) => {
              signals.push(signal);
            },
            probeGroup: () =>
              signals.at(-1) === failAfter ? "unknown" : "running",
            delay: (ms) => {
              elapsed += ms;
              return Promise.resolve();
            },
          },
        );
        expect(result).toEqual({
          status: "unconfirmed",
          reason: "probe-failed",
        });
        expect(elapsed).toBe(failAfter === "SIGTERM" ? 200 : 1200);
        expect(signals).toEqual(
          failAfter === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
