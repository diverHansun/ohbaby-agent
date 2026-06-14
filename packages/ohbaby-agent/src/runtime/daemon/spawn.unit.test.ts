import { describe, expect, it, vi } from "vitest";
import { ensureDaemonRunning } from "./spawn.js";
import type { DaemonState, DaemonStateFile } from "./types.js";

function runningState(
  overrides: Partial<DaemonState> = {},
): DaemonState {
  return {
    authToken: "token_1",
    host: "127.0.0.1",
    packageVersion: "0.1.0",
    pid: 123,
    port: 4096,
    startedAt: 1,
    status: "running",
    updatedAt: 2,
    ...overrides,
  };
}

class MemoryStateFile implements DaemonStateFile {
  readonly read = vi.fn(() => Promise.resolve(this.state));
  readonly write = vi.fn((state: DaemonState) => {
    this.state = state;
    return Promise.resolve();
  });

  constructor(private state: DaemonState | undefined) {}
}

describe("ensureDaemonRunning", () => {
  it("reuses a healthy matching daemon", async () => {
    const stateFile = new MemoryStateFile(runningState());
    const spawn = vi.fn();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, packageVersion: "0.1.0" }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: fetchImpl,
        isProcessAlive: () => true,
        spawn,
        stateFile,
      }),
    ).resolves.toEqual({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      port: 4096,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4096/api/health", {
      headers: { authorization: "Bearer token_1" },
      method: "GET",
    });
  });

  it("spawns when no running daemon is recorded", async () => {
    const stateFile = new MemoryStateFile(undefined);
    const spawn = vi.fn(() => Promise.resolve());

    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawn,
        stateFile,
        waitForState: () =>
          Promise.resolve(runningState({
            authToken: "token_2",
            packageVersion: "0.1.0",
            pid: 124,
            port: 4097,
          })),
      }),
    ).resolves.toMatchObject({ authToken: "token_2", port: 4097 });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("starts the current CLI entrypoint as a background daemon by default", async () => {
    const originalArgv = process.argv;
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));
    process.argv = ["node", "D:/repo/packages/ohbaby-cli/dist/bin.js"];

    try {
      await ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawnProcess,
        stateFile: new MemoryStateFile(undefined),
        waitForState: () =>
          Promise.resolve(runningState({
            authToken: "token_2",
            packageVersion: "0.1.0",
            pid: 124,
            port: 4097,
          })),
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["D:/repo/packages/ohbaby-cli/dist/bin.js", "serve"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("does not detach the auto-spawned daemon on Windows", async () => {
    const originalArgv = process.argv;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));
    process.argv = ["node", "D:/repo/packages/ohbaby-cli/dist/bin.js"];
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      await ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawnProcess,
        stateFile: new MemoryStateFile(undefined),
        waitForState: () =>
          Promise.resolve(runningState({
            authToken: "token_2",
            packageVersion: "0.1.0",
            pid: 124,
            port: 4097,
          })),
      });
    } finally {
      process.argv = originalArgv;
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["D:/repo/packages/ohbaby-cli/dist/bin.js", "serve"],
      expect.objectContaining({
        detached: false,
        windowsHide: true,
      }),
    );
  });

  it("spawns when the recorded pid is stale", async () => {
    const spawn = vi.fn(() => Promise.resolve());

    await ensureDaemonRunning({
      currentVersion: "0.1.0",
      fetch: vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      ),
      isProcessAlive: () => false,
      pollIntervalMs: 0,
      spawn,
      stateFile: new MemoryStateFile(runningState()),
      waitForState: () => Promise.resolve(runningState({ pid: 124 })),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retires a version-mismatched daemon before spawning", async () => {
    const calls: string[] = [];

    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn((input) => {
          calls.push(String(input));
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
          );
        }),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawn: vi.fn(() => {
          calls.push("spawn");
          return Promise.resolve();
        }),
        stateFile: new MemoryStateFile(runningState({ packageVersion: "0.0.9" })),
        waitForState: () =>
          Promise.resolve(runningState({
            authToken: "new_token",
            packageVersion: "0.1.0",
            pid: 124,
            port: 4097,
          })),
      }),
    ).resolves.toMatchObject({ authToken: "new_token", port: 4097 });

    expect(calls).toEqual(["http://127.0.0.1:4096/api/shutdown", "spawn"]);
  });

  it("spawns when health check fails", async () => {
    const spawn = vi.fn(() => Promise.resolve());

    await ensureDaemonRunning({
      currentVersion: "0.1.0",
      fetch: vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 })),
      ),
      isProcessAlive: () => true,
      pollIntervalMs: 0,
      spawn,
      stateFile: new MemoryStateFile(runningState()),
      waitForState: () => Promise.resolve(runningState({ pid: 124 })),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("spawns when health check does not match the recorded daemon version", async () => {
    const spawn = vi.fn(() => Promise.resolve());

    await ensureDaemonRunning({
      currentVersion: "0.1.0",
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, packageVersion: "0.0.9" }),
            { status: 200 },
          ),
        ),
      ),
      isProcessAlive: () => true,
      pollIntervalMs: 0,
      spawn,
      stateFile: new MemoryStateFile(runningState()),
      waitForState: () => Promise.resolve(runningState({ pid: 124 })),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("still spawns when retiring a mismatched daemon fails", async () => {
    const calls: string[] = [];

    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn((input) => {
          calls.push(String(input));
          return Promise.reject(new Error("shutdown unavailable"));
        }),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawn: vi.fn(() => {
          calls.push("spawn");
          return Promise.resolve();
        }),
        stateFile: new MemoryStateFile(runningState({ packageVersion: "0.0.9" })),
        waitForState: () =>
          Promise.resolve(runningState({
            authToken: "new_token",
            packageVersion: "0.1.0",
            pid: 124,
            port: 4097,
          })),
      }),
    ).resolves.toMatchObject({ authToken: "new_token", port: 4097 });

    expect(calls).toEqual(["http://127.0.0.1:4096/api/shutdown", "spawn"]);
  });

  it("fails clearly when the daemon never becomes ready", async () => {
    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 })),
        ),
        isProcessAlive: () => true,
        pollIntervalMs: 0,
        spawn: vi.fn(() => Promise.resolve()),
        stateFile: new MemoryStateFile(undefined),
        timeoutMs: 0,
      }),
    ).rejects.toThrow("daemon did not become ready");
  });
});
