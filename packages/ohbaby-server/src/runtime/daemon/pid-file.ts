import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { DaemonAlreadyRunningError } from "./errors.js";
import type { DaemonPidFile, DaemonPidLock, DaemonPidRecord } from "./types.js";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parsePidRecord(raw: string): DaemonPidRecord | undefined {
  const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
  if (
    typeof parsed.pid !== "number" ||
    typeof parsed.startedAt !== "number" ||
    typeof parsed.token !== "string"
  ) {
    return undefined;
  }

  return {
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    token: parsed.token,
  };
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
      return parsePidRecord(await readFile(this.path, "utf8"));
    } catch {
      return undefined;
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

  async read(): Promise<DaemonPidRecord | undefined> {
    try {
      return parsePidRecord(await readFile(this.path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async acquire(): Promise<DaemonPidLock> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });

    const handle = await this.openExclusive();

    const record: DaemonPidRecord = {
      pid: this.getPid(),
      startedAt: this.now(),
      token: randomUUID(),
    };

    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      return new FilePidLock(record, this.path, handle);
    } catch (error) {
      await handle.close();
      await unlink(this.path).catch(() => undefined);
      throw error;
    }
  }

  private async openExclusive(): Promise<FileHandle> {
    for (;;) {
      try {
        return await open(this.path, "wx");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }

        const existing = await this.read();
        if (!existing || this.isProcessAlive(existing.pid)) {
          throw new DaemonAlreadyRunningError(existing);
        }

        await unlink(this.path).catch((unlinkError: unknown) => {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
            throw unlinkError;
          }
        });
      }
    }
  }
}
