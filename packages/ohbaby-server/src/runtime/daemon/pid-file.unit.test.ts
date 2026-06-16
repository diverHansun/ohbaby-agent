import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonAlreadyRunningError } from "./errors.js";
import { FilePidFile } from "./pid-file.js";

const tempDirs: string[] = [];

async function createPidFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-daemon-pid-"));
  tempDirs.push(directory);
  return join(directory, "daemon.pid");
}

async function readPidFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("FilePidFile", () => {
  it("creates an exclusive pid file and removes it on release", async () => {
    const path = await createPidFilePath();
    const pidFile = new FilePidFile(
      path,
      () => 10,
      () => 1_234,
      () => true,
    );

    const lock = await pidFile.acquire();

    expect(await readPidFile(path)).toMatchObject({
      pid: 1_234,
      startedAt: 10,
    });
    await expect(pidFile.acquire()).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );

    await lock.release();

    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces a stale pid file when the recorded process is gone", async () => {
    const path = await createPidFilePath();
    await writeFile(
      path,
      `${JSON.stringify({ pid: 9_999, startedAt: 1, token: "stale" })}\n`,
      "utf8",
    );
    const checkedPids: number[] = [];
    const pidFile = new FilePidFile(
      path,
      () => 20,
      () => 4_321,
      (pid) => {
        checkedPids.push(pid);
        return false;
      },
    );

    const lock = await pidFile.acquire();

    expect(checkedPids).toEqual([9_999]);
    expect(await readPidFile(path)).toMatchObject({
      pid: 4_321,
      startedAt: 20,
    });

    await lock.release();
  });
});
