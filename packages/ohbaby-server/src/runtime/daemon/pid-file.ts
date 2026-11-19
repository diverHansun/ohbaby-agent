import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonAlreadyRunningError } from "./errors.js";
import type { DaemonPidFile, DaemonPidLock, DaemonPidRecord } from "./types.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const PID_PUBLICATION_DELAY_MS = 25;
const PID_RECOVERY_POLL_MS = 50;
const PID_RECOVERY_WAIT_MS = 2_000;

function parsePidRecord(raw: string): DaemonPidRecord | undefined {
  let parsed: Partial<DaemonPidRecord> | null;
  try {
    parsed = JSON.parse(raw) as Partial<DaemonPidRecord> | null;
  } catch {
    return undefined;
  }
  if (
    typeof parsed?.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.startedAt !== "number" ||
    !Number.isFinite(parsed.startedAt) ||
    typeof parsed.token !== "string" ||
    !parsed.token.trim()
  ) {
    return undefined;
  }

  return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    throw error;
  }
}

class FilePidLock implements DaemonPidLock {
  constructor(
    readonly record: DaemonPidRecord,
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  async release(): Promise<void> {
    await this.handle.close();

    const current = await this.readCurrentRecord();
    if (current?.token !== this.record.token) {
      return;
    }

    try {
      await unlink(this.path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async readCurrentRecord(): Promise<DaemonPidRecord | undefined> {
    try {
      const record = parsePidRecord(await readFile(this.path, "utf8"));
      if (!record) throw new Error(`Invalid daemon PID lock ${this.path}`);
      return record;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class FilePidFile implements DaemonPidFile {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly getPid: () => number = () => process.pid,
    private readonly isProcessAlive: (
      pid: number,
    ) => boolean = defaultIsProcessAlive,
  ) {}

  read(): Promise<DaemonPidRecord | undefined> {
    return this.readRecord(false);
  }

  readForStartup(): Promise<DaemonPidRecord | undefined> {
    return this.readRecord(true);
  }

  async acquire(): Promise<DaemonPidLock> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    try {
      return await this.createLock();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    const existing = await this.readForStartup();
    if (!existing) return this.createAfterInspection();
    this.requireExited(existing);

    // A stale observation cannot authorize deleting the path outside this gate.
    const recoveryPath = `${this.path}.recovery`;
    const recovery = await this.acquireRecoveryLock(recoveryPath);

    try {
      const current = await this.readForStartup();
      if (current) {
        this.requireExited(current);
        await unlink(this.path);
      }
      return await this.createAfterInspection();
    } finally {
      await recovery.close().catch(() => undefined);
      await unlink(recoveryPath).catch(() => undefined);
    }
  }

  private async acquireRecoveryLock(path: string): Promise<FileHandle> {
    const deadline = performance.now() + PID_RECOVERY_WAIT_MS;
    for (;;) {
      try {
        return await open(path, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new Error(`Cannot acquire daemon PID recovery lock ${path}`, {
            cause: error,
          });
        }
      }
      const current = await this.readForStartup();
      if (current) this.requireExited(current);
      if (performance.now() >= deadline) {
        throw new Error(
          `Daemon PID recovery lock still exists at ${path}. Remove it and retry only after confirming that no ohbaby serve process is running or starting.`,
        );
      }
      await delay(PID_RECOVERY_POLL_MS);
    }
  }

  private requireExited(record: DaemonPidRecord): void {
    let alive: boolean;
    try {
      alive = this.isProcessAlive(record.pid);
    } catch (error) {
      throw new Error(
        `Cannot verify the process owning daemon PID lock ${this.path}`,
        { cause: error },
      );
    }
    if (alive) throw new DaemonAlreadyRunningError(record);
  }

  private async readRecord(
    waitForPublication: boolean,
  ): Promise<DaemonPidRecord | undefined> {
    const recoveryHint = waitForPublication
      ? " Wait for startup to finish and retry. If this persists, remove the file only after confirming that no ohbaby serve process is running or starting."
      : "";
    for (;;) {
      let raw: string;
      try {
        raw = await readFile(this.path, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw new Error(`Cannot read daemon PID lock ${this.path}`, {
          cause: error,
        });
      }

      const record = parsePidRecord(raw);
      if (record) return record;
      if (!waitForPublication) {
        throw new Error(`Invalid daemon PID lock ${this.path}.${recoveryHint}`);
      }
      waitForPublication = false;
      await delay(PID_PUBLICATION_DELAY_MS);
    }
  }

  private async createAfterInspection(): Promise<DaemonPidLock> {
    try {
      return await this.createLock();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      throw new DaemonAlreadyRunningError(await this.readForStartup());
    }
  }

  private async createLock(): Promise<DaemonPidLock> {
    const record: DaemonPidRecord = {
      pid: this.getPid(),
      startedAt: this.now(),
      token: randomUUID(),
    };
    const handle = await open(this.path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      return new FilePidLock(record, this.path, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw error;
    }
  }
}
