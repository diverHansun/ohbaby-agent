import { lookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import { createShutdownOptions, withinShutdown } from "ohbaby-agent";
import { readFile, lstat } from "node:fs/promises";
import { FilePidFile } from "./pid-file.js";
import {
  JsonDaemonStateFile,
  legacyShutdownReportPath,
  shutdownReportPath,
} from "./state-file.js";
import { resolveDaemonScope, type ResolveDaemonScopeOptions } from "./scope.js";
import { daemonAuthHeader } from "../../auth/token.js";
import type {
  DaemonPidRecord,
  DaemonShutdownReport,
  DaemonState,
} from "./types.js";

interface DaemonIdentity {
  readonly pid: number;
  readonly token: string;
}

export interface StopDaemonResult {
  readonly processExit: "confirmed" | "not-running" | "unconfirmed";
  readonly cleanup: "confirmed" | "unconfirmed" | "unknown";
  readonly target?: DaemonIdentity;
  readonly rejection?: readonly string[];
  readonly requestAccepted?: boolean;
  readonly reason?: string;
}

export interface StopDaemonFromStateOptions extends ResolveDaemonScopeOptions {
  /** Uses authenticated idle-only shutdown, bound to the caller's inspection. */
  readonly idleTarget?: DaemonIdentity;
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
    await lstat(path);
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
  throw new Error(`Could not validate daemon identity file ${path}`);
}

interface DaemonIdentityFiles {
  readonly state?: DaemonState;
  readonly lock?: DaemonPidRecord;
  readonly statePath: string;
  readonly pidFile: FilePidFile;
}

async function readDaemonIdentity(
  options: ResolveDaemonScopeOptions,
): Promise<DaemonIdentityFiles> {
  const scope = await resolveDaemonScope(options);
  const readFiles = async (
    statePath: string,
    pidPath: string,
  ): Promise<DaemonIdentityFiles> => {
    const pidFile = new FilePidFile(pidPath);
    const state = await readIdentity(statePath, () =>
      new JsonDaemonStateFile(statePath).read(),
    );
    const lock = await readIdentity(pidPath, () => pidFile.read());
    return { state, lock, statePath, pidFile };
  };
  const global = await readFiles(scope.stateFilePath, scope.pidFilePath);
  return global.state || global.lock
    ? global
    : readFiles(scope.legacyStateFilePath, scope.legacyPidFilePath);
}

function matchesIdentity(
  record: DaemonPidRecord | DaemonIdentity | undefined,
  target: DaemonIdentity,
): boolean {
  return record?.pid === target.pid && record.token === target.token;
}

class IdleShutdownRefusedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(" "));
  }
}

// Both the global HTTP agent and global fetch can be configured to use a proxy.
const localShutdownAgent = new HttpAgent({ proxyEnv: {} });

async function localDaemonAddress(host: string): Promise<string> {
  const unbracketed = host.replace(/^\[(.*)\]$/u, "$1");
  if (unbracketed === "0.0.0.0") return "127.0.0.1";
  if (unbracketed === "::") return "::1";

  const { address, family } = await lookup(unbracketed);
  const local = new BlockList();
  local.addSubnet("127.0.0.0", 8);
  local.addAddress("::1", "ipv6");
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      local.addAddress(
        entry.address,
        entry.family === "IPv6" ? "ipv6" : "ipv4",
      );
    }
  }
  if (!local.check(address, family === 6 ? "ipv6" : "ipv4"))
    throw new Error("The daemon address is not on this machine.");
  return address;
}

function postLocalIdleShutdown({
  authToken,
  hostname,
  port,
  pidToken,
  signal,
}: {
  readonly authToken: string;
  readonly hostname: string;
  readonly port: number;
  readonly pidToken: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly status: number; readonly body?: string }> {
  const body = JSON.stringify({ pidToken });
  return new Promise((resolve, reject) => {
    let conflictReceived = false;
    const request = httpRequest(
      {
        agent: localShutdownAgent,
        hostname,
        port,
        path: "/api/shutdown/idle",
        method: "POST",
        headers: {
          authorization: daemonAuthHeader(authToken),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const finish = (): void => {
          resolve({ status });
        };
        response.once("error", finish);
        if (status !== 409) {
          response.resume();
          finish();
          return;
        }
        conflictReceived = true;
        const limit = 64 * 1024;
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          result += chunk.slice(0, limit - result.length);
        });
        response.once("end", () => {
          resolve({ status, body: result });
        });
        response.once("close", finish);
      },
    );
    request.once("error", (error) => {
      if (conflictReceived) resolve({ status: 409 });
      else reject(error);
    });
    request.end(body);
  });
}

async function requestIdleShutdown(
  state: DaemonState,
  target: DaemonIdentity,
  signal: AbortSignal,
): Promise<void> {
  if (!state.host || !state.port || !state.authToken)
    throw new Error("Daemon authentication identity is unavailable");
  let hostname: string;
  try {
    hostname = await localDaemonAddress(state.host);
  } catch {
    throw new IdleShutdownRefusedError([
      "Could not verify that the daemon is listening on a local address.",
    ]);
  }
  signal.throwIfAborted();
  const response = await postLocalIdleShutdown({
    hostname,
    authToken: state.authToken,
    port: state.port,
    pidToken: target.token,
    signal,
  });
  if (response.status === 404)
    throw new IdleShutdownRefusedError([
      "The running daemon does not support idle shutdown. Confirm its tasks are finished, run ohbaby serve stop, then try again.",
    ]);
  if (response.status === 409) {
    let body: unknown;
    try {
      body = JSON.parse(response.body ?? "");
    } catch {
      // The conflict status is definitive even if its reasons are unavailable.
    }
    const reasons =
      body &&
      typeof body === "object" &&
      "reasons" in body &&
      Array.isArray(body.reasons)
        ? body.reasons.filter(
            (reason): reason is string => typeof reason === "string",
          )
        : [];
    throw new IdleShutdownRefusedError([
      "The daemon declined to stop. Wait for active work to finish and try again.",
      ...reasons,
    ]);
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Daemon idle shutdown request failed: HTTP ${String(response.status)}`,
    );
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

async function readShutdownCleanup(
  path: string,
  target: NonNullable<StopDaemonResult["target"]>,
): Promise<DaemonShutdownReport["cleanup"] | undefined> {
  try {
    const report = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<DaemonShutdownReport>;
    if (
      report.pid === target.pid &&
      report.pidToken === target.token &&
      (report.cleanup?.status === "confirmed" ||
        report.cleanup?.status === "unconfirmed") &&
      Array.isArray(report.cleanup.errors) &&
      report.cleanup.errors.every((error) => typeof error === "string")
    ) {
      return report.cleanup;
    }
  } catch {
    // An absent or unreadable report does not prove cleanup.
  }
  return undefined;
}

async function readMatchingCleanup(
  statePath: string,
  target: DaemonIdentity,
): Promise<DaemonShutdownReport["cleanup"] | undefined> {
  return (
    (await readShutdownCleanup(shutdownReportPath(statePath), target)) ??
    (await readShutdownCleanup(
      legacyShutdownReportPath(statePath, target.token),
      target,
    ))
  );
}

export type DaemonMaintenanceStatus =
  | { readonly kind: "empty" }
  | { readonly kind: "running" | "stopped"; readonly target: DaemonIdentity }
  | { readonly kind: "blocked"; readonly reason: string };

/** Reads identity and cleanup records without opening the workspace database. */
export async function inspectDaemonForMaintenance(
  options: ResolveDaemonScopeOptions,
): Promise<DaemonMaintenanceStatus> {
  const blocked = (reason: string): DaemonMaintenanceStatus => ({
    kind: "blocked",
    reason,
  });
  try {
    const { state, lock, statePath, pidFile } =
      await readDaemonIdentity(options);
    if (!state && !lock) return { kind: "empty" };
    if (
      !state?.pid ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 0 ||
      !state.pidToken?.trim()
    )
      return blocked(
        "The daemon lock or state exists without a verifiable identity.",
      );
    const target = { pid: state.pid, token: state.pidToken };
    if (lock && !matchesIdentity(lock, target))
      return blocked("The daemon state and process lock do not match.");
    const liveness = observeProcess(target.pid);
    if (liveness === "unknown")
      return blocked(`Could not verify daemon process ${String(target.pid)}.`);
    if (liveness === "alive") {
      if (!lock || state.status !== "running")
        return blocked(
          "The daemon is starting, stopping, or has an unverifiable process lock. Try again after it settles.",
        );
      return { kind: "running", target };
    }
    const cleanup = await readMatchingCleanup(statePath, target);
    if (cleanup?.status !== "confirmed") {
      const details = cleanup?.errors.join(" ");
      return blocked(
        `Cleanup for daemon process ${String(target.pid)} could not be confirmed.${details ? ` ${details}` : ""}`,
      );
    }
    const current = await pidFile.read();
    if (lock ? !matchesIdentity(current, target) : current !== undefined)
      return blocked("The daemon process lock changed during inspection.");
    return { kind: "stopped", target };
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
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
    const { state, lock, statePath, pidFile } =
      await readDaemonIdentity(options);
    if (
      options.idleTarget &&
      (state?.pid !== options.idleTarget.pid ||
        state.pidToken !== options.idleTarget.token)
    )
      return failure(
        "Daemon identity changed before the idle shutdown request.",
      );
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
    const confirmed = async (
      requestAccepted: boolean,
    ): Promise<StopDaemonResult> => {
      const cleanup = await readMatchingCleanup(statePath, target);
      const reason = cleanup?.errors.join("; ");
      return {
        processExit: "confirmed",
        cleanup: cleanup?.status ?? "unknown",
        target,
        ...(options.idleTarget && requestAccepted ? { requestAccepted } : {}),
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
    if (!matchesIdentity(lock, target))
      return failure(
        "Refusing to stop daemon: state does not match the live pid lock",
        target,
      );
    // Recheck the lock immediately before the only shutdown request. Production
    // uses authenticated HTTP, so a recycled unrelated PID is never signalled.
    const current = await pidFile.read();
    if (!matchesIdentity(current, target))
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
      const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      if (options.idleTarget)
        await requestIdleShutdown(state, options.idleTarget, signal);
      else if (options.kill) options.kill(target.pid, "SIGTERM");
      else await (options.requestShutdown ?? requestShutdown)(state, signal);
    } catch (error) {
      if (error instanceof IdleShutdownRefusedError) {
        return {
          ...failure(error.message, target),
          rejection: error.reasons,
        };
      }
      requestError = error instanceof Error ? error.message : String(error);
    }
    while (Date.now() < deadlineAt) {
      const liveness = observe(target.pid);
      if (liveness === "dead")
        return await confirmed(requestError === undefined);
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
