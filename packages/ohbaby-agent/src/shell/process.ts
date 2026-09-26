import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { SIGKILL_TIMEOUT_MS } from "./constants.js";

export type ProcessTreeState = "running" | "stopped" | "unknown";

export interface KillTreeResult {
  readonly status: "confirmed" | "unconfirmed";
  readonly reason?:
    | "missing-pid"
    | "probe-failed"
    | "termination-failed"
    | "observation-expired";
  /** Windows taskkill succeeded; a later owned exit can complete confirmation. */
  readonly terminationSucceeded?: boolean;
}

export interface KillTreeOptions {
  readonly exited?: () => boolean;
}

export interface ProcessTreeProbeOptions extends KillTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly probeGroup?: (pid: number) => ProcessTreeState;
  readonly terminationSucceeded?: boolean;
}

export interface KillTreePlatformOptions extends ProcessTreeProbeOptions {
  readonly delay?: (ms: number) => Promise<void>;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly spawnTaskkill?: (pid: number) => Promise<void>;
  readonly observationMs?: number;
  readonly pollIntervalMs?: number;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultSpawnTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 1000,
    });
    proc.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with code ${String(code)}`));
    });
    proc.once("error", reject);
  });
}

function defaultProbeGroup(pid: number): ProcessTreeState {
  try {
    process.kill(-pid, 0);
    return "running";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "stopped"
      : "unknown";
  }
}

/** Probe only the original owned group; leader exit and pipe close are not proof. */
export function probeProcessTree(
  proc: Pick<ChildProcess, "pid">,
  options: ProcessTreeProbeOptions = {},
): ProcessTreeState {
  if (!proc.pid || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) {
    return "unknown";
  }
  try {
    if ((options.platform ?? process.platform) === "win32") {
      return options.terminationSucceeded && options.exited?.()
        ? "stopped"
        : "unknown";
    }
    return (options.probeGroup ?? defaultProbeGroup)(proc.pid);
  } catch {
    return "unknown";
  }
}

async function observe(
  probe: () => ProcessTreeState,
  budgetMs: number,
  options: KillTreePlatformOptions,
  recoverUnknown = false,
): Promise<ProcessTreeState> {
  const startedAt = Date.now();
  let waitedMs = 0;
  for (;;) {
    const state = probe();
    if (state === "stopped" || (state === "unknown" && !recoverUnknown)) {
      return state;
    }
    const elapsedMs = Math.max(Date.now() - startedAt, waitedMs);
    if (elapsedMs >= budgetMs) return state;
    const delayMs = Math.min(
      Math.max(1, options.pollIntervalMs ?? 20),
      budgetMs - elapsedMs,
    );
    await (options.delay ?? defaultDelay)(delayMs);
    waitedMs += delayMs;
  }
}

function observedResult(state: ProcessTreeState): KillTreeResult {
  if (state === "stopped") return { status: "confirmed" };
  return {
    status: "unconfirmed",
    reason: state === "unknown" ? "probe-failed" : "observation-expired",
  };
}

export async function killTreeWithPlatform(
  proc: Pick<ChildProcess, "pid">,
  options: KillTreePlatformOptions = {},
): Promise<KillTreeResult> {
  const pid = proc.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "unconfirmed", reason: "missing-pid" };
  }
  const observationMs = Math.max(0, options.observationMs ?? 1000);
  if ((options.platform ?? process.platform) === "win32") {
    try {
      // Once our owned leader has exited, its numeric PID may name an unrelated
      // process. Without a native tree handle, never issue a new taskkill.
      if (options.exited?.()) {
        return options.terminationSucceeded
          ? { status: "confirmed", terminationSucceeded: true }
          : { status: "unconfirmed", reason: "termination-failed" };
      }
    } catch {
      return { status: "unconfirmed", reason: "probe-failed" };
    }
    const termination = { succeeded: false, failed: false };
    // A stuck/rejecting terminator cannot make the observation unbounded or
    // turn a leader exit into a successful tree termination.
    try {
      void (options.spawnTaskkill ?? defaultSpawnTaskkill)(pid).then(
        () => {
          termination.succeeded = true;
        },
        () => {
          termination.failed = true;
        },
      );
    } catch {
      termination.failed = true;
    }
    const state = await observe(
      () => {
        if (termination.failed) return "unknown";
        if (!termination.succeeded) return "running";
        try {
          return options.exited?.() ? "stopped" : "running";
        } catch {
          return "unknown";
        }
      },
      observationMs,
      options,
    );
    return {
      ...observedResult(state),
      ...(termination.failed ? { reason: "termination-failed" as const } : {}),
      ...(termination.succeeded ? { terminationSucceeded: true } : {}),
    };
  }

  const probe = (): ProcessTreeState => probeProcessTree(proc, options);
  const initial = probe();
  if (initial !== "running") return observedResult(initial);
  const killProcess = options.killProcess ?? process.kill.bind(process);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      killProcess(-pid, signal);
    } catch {
      // The group may have disappeared between the probe and the signal.
      if (probe() === "stopped") return { status: "confirmed" };
      return { status: "unconfirmed", reason: "termination-failed" };
    }
    const state = await observe(
      probe,
      signal === "SIGTERM" ? SIGKILL_TIMEOUT_MS : observationMs,
      options,
      // An owned POSIX group can transiently fail a probe while exiting. Observe
      // again within this same deadline; unknown never authorizes escalation.
      true,
    );
    if (state !== "running" || signal === "SIGKILL") {
      return observedResult(state);
    }
  }
  return { status: "unconfirmed", reason: "observation-expired" };
}

// Child identity, not PID, owns one bounded termination attempt.
const terminationAttempts = new WeakMap<
  ChildProcess,
  Promise<KillTreeResult>
>();

export function killTree(
  proc: ChildProcess,
  options: KillTreeOptions = {},
): Promise<KillTreeResult> {
  const existing = terminationAttempts.get(proc);
  if (existing) return existing;
  const attempt = killTreeWithPlatform(proc, {
    ...options,
    exited:
      options.exited ??
      ((): boolean => proc.exitCode !== null || proc.signalCode !== null),
  });
  terminationAttempts.set(proc, attempt);
  return attempt;
}
