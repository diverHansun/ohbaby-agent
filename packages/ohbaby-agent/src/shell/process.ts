import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { SIGKILL_TIMEOUT_MS } from "./constants.js";

export interface KillTreeOptions {
  readonly exited?: () => boolean;
}

export interface KillTreePlatformOptions extends KillTreeOptions {
  readonly delay?: (ms: number) => Promise<void>;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly platform?: NodeJS.Platform;
  readonly spawnTaskkill?: (pid: number) => Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultSpawnTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    });
    proc.once("exit", () => {
      resolve();
    });
    proc.once("error", () => {
      resolve();
    });
  });
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function isExited(options: KillTreeOptions): boolean {
  return options.exited?.() ?? false;
}

export async function killTreeWithPlatform(
  proc: Pick<ChildProcess, "pid">,
  options: KillTreePlatformOptions = {},
): Promise<void> {
  const pid = proc.pid;
  if (!pid || isExited(options)) {
    return;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await (options.spawnTaskkill ?? defaultSpawnTaskkill)(pid);
    return;
  }

  const killProcess = options.killProcess ?? defaultKillProcess;
  try {
    killProcess(-pid, "SIGTERM");
  } catch {
    try {
      killProcess(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await (options.delay ?? defaultDelay)(SIGKILL_TIMEOUT_MS);
  if (isExited(options)) {
    return;
  }
  try {
    killProcess(-pid, "SIGKILL");
  } catch {
    try {
      killProcess(pid, "SIGKILL");
    } catch {
      // Stale process cleanup is best effort.
    }
  }
}

export function killTree(
  proc: ChildProcess,
  options: KillTreeOptions = {},
): Promise<void> {
  return killTreeWithPlatform(proc, options);
}
