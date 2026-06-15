import {
  spawn as spawnChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { daemonAuthHeader } from "./auth.js";
import { JsonDaemonStateFile } from "./state-file.js";
import type { DaemonState, DaemonStateFile } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STATE_FILE = resolve(".ohbaby", "daemon-state.json");
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface RunningDaemonConnection {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly packageVersion: string;
}

export interface EnsureDaemonRunningOptions {
  readonly currentVersion: string;
  readonly stateFile?: DaemonStateFile;
  readonly stateFilePath?: string;
  readonly fetch?: typeof fetch;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly spawn?: () => Promise<void>;
  readonly spawnProcess?: SpawnDetachedDaemonProcess;
  readonly waitForState?: () => Promise<DaemonState>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export type SpawnDetachedDaemonProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    return true;
  }
}

function isRunningState(
  state: DaemonState | undefined,
): state is DaemonState & {
  readonly authToken: string;
  readonly host: string;
  readonly packageVersion: string;
  readonly pid: number;
  readonly port: number;
} {
  return (
    state?.status === "running" &&
    typeof state.pid === "number" &&
    typeof state.host === "string" &&
    state.host.length > 0 &&
    typeof state.port === "number" &&
    typeof state.packageVersion === "string" &&
    state.packageVersion.length > 0 &&
    typeof state.authToken === "string" &&
    state.authToken.length > 0
  );
}

function toConnection(
  state: ReturnType<typeof assertRunningState>,
): RunningDaemonConnection {
  return {
    authToken: state.authToken,
    host: state.host,
    packageVersion: state.packageVersion,
    port: state.port,
  };
}

function assertRunningState(state: DaemonState): DaemonState & {
  readonly authToken: string;
  readonly host: string;
  readonly packageVersion: string;
  readonly pid: number;
  readonly port: number;
} {
  if (!isRunningState(state)) {
    throw new Error("daemon did not become ready");
  }
  return state;
}

function crashReason(state: DaemonState | undefined): string | undefined {
  if (
    state?.status === "crashed" &&
    typeof state.error === "string" &&
    state.error.trim().length > 0
  ) {
    return state.error.trim();
  }
  return undefined;
}

function stateUrl(
  state: { readonly host?: string; readonly port?: number },
  path: string,
): string {
  const host = state.host ?? DEFAULT_HOST;
  return `http://${host}:${String(state.port)}/${path.replace(/^\/+/, "")}`;
}

async function isHealthy(
  state: ReturnType<typeof assertRunningState>,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(stateUrl(state, "/api/health"), {
      headers: { authorization: daemonAuthHeader(state.authToken) },
      method: "GET",
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json().catch(() => undefined)) as
      | { readonly ok?: unknown; readonly packageVersion?: unknown }
      | undefined;
    return body?.ok === true && body.packageVersion === state.packageVersion;
  } catch {
    return false;
  }
}

async function requestShutdown(
  state: ReturnType<typeof assertRunningState>,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    await fetchImpl(stateUrl(state, "/api/shutdown"), {
      headers: { authorization: daemonAuthHeader(state.authToken) },
      method: "POST",
    });
  } catch {
    // Continue to spawn and poll; the old daemon may already be gone or stale.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function defaultSpawn(
  spawnProcess: SpawnDetachedDaemonProcess = spawnChildProcess,
): Promise<void> {
  const entrypoint = process.argv[1].trim();
  if (entrypoint.length === 0) {
    throw new Error("daemon spawn entrypoint is unavailable");
  }

  const child = spawnProcess(
    process.execPath,
    [entrypoint, "serve", "--port", "0"],
    {
      cwd: process.cwd(),
      // Windows detached console processes can flash a separate terminal window.
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return Promise.resolve();
}

async function waitForReadyState(
  options: Required<
    Pick<
      EnsureDaemonRunningOptions,
      | "currentVersion"
      | "fetch"
      | "isProcessAlive"
      | "pollIntervalMs"
      | "timeoutMs"
    >
  > & {
    readonly stateFile: DaemonStateFile;
    readonly waitForState?: () => Promise<DaemonState>;
  },
): Promise<RunningDaemonConnection> {
  if (options.waitForState) {
    const state = assertRunningState(await options.waitForState());
    if (state.packageVersion !== options.currentVersion) {
      throw new Error("daemon did not become ready");
    }
    return toConnection(state);
  }

  const deadline = Date.now() + options.timeoutMs;
  let lastCrashReason: string | undefined;
  for (;;) {
    const state = options.stateFile.read
      ? await options.stateFile.read()
      : undefined;
    lastCrashReason = crashReason(state) ?? lastCrashReason;
    if (
      isRunningState(state) &&
      state.packageVersion === options.currentVersion &&
      options.isProcessAlive(state.pid) &&
      (await isHealthy(state, options.fetch))
    ) {
      return toConnection(state);
    }
    if (Date.now() >= deadline) {
      if (lastCrashReason !== undefined) {
        throw new Error(`daemon did not become ready: ${lastCrashReason}`);
      }
      throw new Error("daemon did not become ready");
    }
    await delay(options.pollIntervalMs);
  }
}

export async function ensureDaemonRunning(
  options: EnsureDaemonRunningOptions,
): Promise<RunningDaemonConnection> {
  const stateFile =
    options.stateFile ??
    new JsonDaemonStateFile(options.stateFilePath ?? DEFAULT_STATE_FILE);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to discover the daemon");
  }
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const spawn =
    options.spawn ?? ((): Promise<void> => defaultSpawn(options.spawnProcess));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const state = stateFile.read ? await stateFile.read() : undefined;
  if (isRunningState(state) && isProcessAlive(state.pid)) {
    if (state.packageVersion !== options.currentVersion) {
      await requestShutdown(state, fetchImpl);
    } else if (await isHealthy(state, fetchImpl)) {
      return toConnection(state);
    }
  }

  await spawn();
  return waitForReadyState({
    currentVersion: options.currentVersion,
    fetch: fetchImpl,
    isProcessAlive,
    pollIntervalMs,
    stateFile,
    timeoutMs,
    ...(options.waitForState === undefined
      ? {}
      : { waitForState: options.waitForState }),
  });
}
