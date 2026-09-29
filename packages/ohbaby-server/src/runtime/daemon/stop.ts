import { createShutdownOptions, withinShutdown } from "ohbaby-agent";
import { readFile, stat } from "node:fs/promises";
import { FilePidFile } from "./pid-file.js";
import { JsonDaemonStateFile, shutdownReportPath } from "./state-file.js";
import { resolveDaemonScope } from "./scope.js";
import type { DaemonShutdownReport, DaemonState } from "./types.js";

export interface StopDaemonResult {
  readonly processExit: "confirmed" | "not-running" | "unconfirmed";
  readonly cleanup: "confirmed" | "unconfirmed" | "unknown";
  readonly target?: { readonly pid: number; readonly token: string };
  readonly reason?: string;
}

export interface StopDaemonFromStateOptions {
  readonly homeDirectory?: string;
  readonly workdir?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  readonly observeProcess?: (pid: number) => "alive" | "dead" | "unknown";
  readonly requestShutdown?: (
    state: DaemonState,
    signal: AbortSignal,
  ) => Promise<void>;
}

function observeProcess(pid: number): "alive" | "dead" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}

async function readIdentity<T>(
  path: string,
  read: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const record = await read();
  if (record !== undefined) return record;
  try {
    await stat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
  throw new Error("Daemon identity file exists but could not be validated");
}

async function requestShutdown(
  state: DaemonState,
  signal: AbortSignal,
): Promise<void> {
  if (!state.host || !state.port || !state.authToken)
    throw new Error("Daemon authentication identity is unavailable");
  const response = await fetch(
    `http://${state.host}:${String(state.port)}/api/shutdown`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.authToken}` },
      signal,
    },
  );
  if (!response.ok)
    throw new Error(
      `Daemon shutdown request failed: HTTP ${String(response.status)}`,
    );
}

async function observeDaemonStop(
  options: StopDaemonFromStateOptions,
  deadlineAt: number,
): Promise<StopDaemonResult> {
  const observe = options.observeProcess ?? observeProcess;
  const failure = (
    reason: string,
    target?: StopDaemonResult["target"],
  ): StopDaemonResult => ({
    processExit: "unconfirmed",
    cleanup: "unknown",
    reason,
    ...(target ? { target } : {}),
  });
  try {
    const scope = await resolveDaemonScope(options);
    const globalState = await readIdentity(scope.stateFilePath, () =>
      new JsonDaemonStateFile(scope.stateFilePath).read(),
    );
    const globalLock = await readIdentity(scope.pidFilePath, () =>
      new FilePidFile(scope.pidFilePath).read(),
    );
    const legacy = globalState === undefined && globalLock === undefined;
    const statePath = legacy ? scope.legacyStateFilePath : scope.stateFilePath;
    const pidFile = new FilePidFile(
      legacy ? scope.legacyPidFilePath : scope.pidFilePath,
    );
    const state = legacy
      ? await readIdentity(statePath, () =>
          new JsonDaemonStateFile(statePath).read(),
        )
      : globalState;
    const lock = legacy
      ? await readIdentity(scope.legacyPidFilePath, () => pidFile.read())
      : globalLock;
    if (!state?.pid || !state.pidToken) {
      if (lock && observe(lock.pid) !== "dead")
        return failure(
          "Daemon identity is missing while its pid lock may still be live",
        );
      if (state?.pid && observe(state.pid) !== "dead")
        return failure("Daemon state lacks a verifiable pid token");
      return { processExit: "not-running", cleanup: "unknown" };
    }
    const target = { pid: state.pid, token: state.pidToken };
    const confirmed = async (): Promise<StopDaemonResult> => {
      let cleanup: StopDaemonResult["cleanup"] = "unknown";
      let reason: string | undefined;
      try {
        const report = JSON.parse(
          await readFile(shutdownReportPath(statePath, target.token), "utf8"),
        ) as Partial<DaemonShutdownReport>;
        if (
          report.pid === target.pid &&
          report.pidToken === target.token &&
          (report.cleanup?.status === "confirmed" ||
            report.cleanup?.status === "unconfirmed") &&
          Array.isArray(report.cleanup.errors) &&
          report.cleanup.errors.every((error) => typeof error === "string")
        ) {
          cleanup = report.cleanup.status;
          reason = report.cleanup.errors.join("; ") || undefined;
        }
      } catch {
        /* An absent/malformed report cannot prove cleanup. */
      }
      return {
        processExit: "confirmed",
        cleanup,
        target,
        ...(reason ? { reason } : {}),
      };
    };
    const initial = observe(target.pid);
    if (initial === "unknown")
      return failure("Process liveness could not be verified", target);
    if (initial === "dead") {
      if (lock && (lock.pid !== target.pid || lock.token !== target.token))
        return failure("Daemon pid lock identity changed", target);
      return { processExit: "not-running", cleanup: "unknown", target };
    }
    if (lock?.pid !== target.pid || lock.token !== target.token)
      return failure(
        "Refusing to stop daemon: state does not match the live pid lock",
        target,
      );
    // Recheck the lock immediately before the only shutdown request. Production
    // uses authenticated HTTP, so a recycled unrelated PID is never signalled.
    const current = await pidFile.read();
    if (current?.pid !== target.pid || current.token !== target.token)
      return failure(
        "Daemon pid lock identity changed before shutdown",
        target,
      );
    if (Date.now() >= deadlineAt)
      return failure(
        "Shutdown observation deadline exceeded before request",
        target,
      );
    let requestError: string | undefined;
    try {
      if (options.kill) options.kill(target.pid, "SIGTERM");
      else
        await (options.requestShutdown ?? requestShutdown)(
          state,
          AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
        );
    } catch (error) {
      requestError = error instanceof Error ? error.message : String(error);
    }
    while (Date.now() < deadlineAt) {
      const liveness = observe(target.pid);
      if (liveness === "dead") return await confirmed();
      if (liveness === "unknown")
        return failure("Process liveness could not be verified", target);
      const currentLock = await pidFile.read();
      if (
        currentLock &&
        (currentLock.pid !== target.pid || currentLock.token !== target.token)
      )
        return failure(
          "Daemon identity changed while awaiting the original process",
          target,
        );
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(options.pollMs ?? 25, Math.max(0, deadlineAt - Date.now())),
        ),
      );
    }
    return failure(
      requestError ??
        "Original daemon process exit was not confirmed before the observation deadline",
      target,
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function stopDaemonFromState(
  options: StopDaemonFromStateOptions = {},
): Promise<StopDaemonResult> {
  const shutdown = createShutdownOptions(options.timeoutMs ?? 12_000);
  try {
    return await withinShutdown(shutdown, "daemon observation", () =>
      observeDaemonStop(options, shutdown.deadlineAt),
    );
  } catch (error) {
    return {
      processExit: "unconfirmed",
      cleanup: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
