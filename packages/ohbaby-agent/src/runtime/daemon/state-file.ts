import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { DaemonState, DaemonStateFile } from "./types.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseDaemonState(raw: string): DaemonState | undefined {
  const parsed = JSON.parse(raw) as Partial<DaemonState>;
  if (
    parsed.status !== "running" &&
    parsed.status !== "stopping" &&
    parsed.status !== "stopped" &&
    parsed.status !== "crashed"
  ) {
    return undefined;
  }
  if (typeof parsed.updatedAt !== "number") {
    return undefined;
  }
  if (
    parsed.status === "running" &&
    (typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      parsed.host.length === 0 ||
      !Number.isInteger(parsed.port) ||
      typeof parsed.packageVersion !== "string" ||
      parsed.packageVersion.length === 0 ||
      typeof parsed.authToken !== "string" ||
      parsed.authToken.length === 0)
  ) {
    return undefined;
  }

  return {
    status: parsed.status,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    updatedAt: parsed.updatedAt,
    error: parsed.error,
    host: parsed.host,
    port: parsed.port,
    packageVersion: parsed.packageVersion,
    authToken: parsed.authToken,
    idleSince: parsed.idleSince,
  };
}

export class JsonDaemonStateFile implements DaemonStateFile {
  constructor(private readonly path: string) {}

  async read(): Promise<DaemonState | undefined> {
    try {
      return parseDaemonState(await readFile(this.path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async write(state: DaemonState): Promise<void> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    const tempPath = `${this.path}.${String(process.pid)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.path);
  }
}
