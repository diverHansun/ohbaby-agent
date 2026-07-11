import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface DaemonPidRecord {
  readonly pid: number;
  readonly token: string;
}

interface DaemonState {
  readonly authToken: string;
  readonly host: string;
  readonly packageVersion: string;
  readonly pid: number;
  readonly pidToken: string;
  readonly port: number;
  readonly status: string;
}

export interface ReadServeCoexistenceNoticeOptions {
  readonly fetch?: typeof fetch;
  readonly homeDirectory?: string;
  readonly packageVersion: string;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isPidRecord(value: unknown): value is DaemonPidRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "token" in value &&
    typeof value.token === "string"
  );
}

function isDaemonState(value: unknown): value is DaemonState {
  return (
    typeof value === "object" &&
    value !== null &&
    "authToken" in value &&
    typeof value.authToken === "string" &&
    "host" in value &&
    typeof value.host === "string" &&
    "packageVersion" in value &&
    typeof value.packageVersion === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "pidToken" in value &&
    typeof value.pidToken === "string" &&
    "port" in value &&
    typeof value.port === "number" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readServeCoexistenceNotice(
  options: ReadServeCoexistenceNoticeOptions,
): Promise<string | undefined> {
  try {
    const serverDirectory = join(
      options.homeDirectory ?? homedir(),
      ".ohbaby",
      "server",
    );
    const [pidValue, stateValue] = await Promise.all([
      readJson(join(serverDirectory, "daemon.pid")),
      readJson(join(serverDirectory, "daemon-state.json")),
    ]);
    if (!isPidRecord(pidValue) || !isDaemonState(stateValue)) {
      return undefined;
    }
    if (
      stateValue.status !== "running" ||
      stateValue.pid !== pidValue.pid ||
      stateValue.pidToken !== pidValue.token ||
      stateValue.packageVersion !== options.packageVersion ||
      !isProcessAlive(pidValue.pid)
    ) {
      return undefined;
    }
    const url = `http://${stateValue.host}:${String(stateValue.port)}`;
    const response = await (options.fetch ?? globalThis.fetch)(
      `${url}/api/health`,
      {
        headers: { authorization: `Bearer ${stateValue.authToken}` },
        signal: AbortSignal.timeout(500),
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const health: unknown = await response.json();
    if (
      typeof health !== "object" ||
      health === null ||
      !("packageVersion" in health) ||
      health.packageVersion !== options.packageVersion
    ) {
      return undefined;
    }
    return `ohbaby serve is also running at ${url}. This terminal remains in-process; the same session is protected by the shared run claim.\n`;
  } catch {
    return undefined;
  }
}
