import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonAlreadyRunningError } from "./errors.js";
import { FilePidFile } from "./pid-file.js";

vi.mock("node:timers/promises", async (load) => {
  const timers = await load<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

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

    expect(checkedPids).toEqual([9_999, 9_999]);
    expect(await readPidFile(path)).toMatchObject({
      pid: 4_321,
      startedAt: 20,
    });

    await lock.release();
  });

  it.each(["{", `{"pid":0,"startedAt":1,"token":"invalid"}`])(
    "preserves an invalid lock: %s",
    async (record) => {
      const path = await createPidFilePath();
      await writeFile(path, record);
      const pidFile = new FilePidFile(
        path,
        Date.now,
        () => 1234,
        () => false,
      );
      await expect(pidFile.acquire()).rejects.toThrow(
        /no ohbaby serve process is running or starting/,
      );
      expect(await readFile(path, "utf8")).toBe(record);
    },
  );

  it("does not touch a dead lock while a recovery gate is held", async () => {
    const path = await createPidFilePath();
    const record = { pid: 9_999, startedAt: 1, token: "stale" };
    await writeFile(path, JSON.stringify(record));
    await writeFile(`${path}.recovery`, "");
    const pidFile = new FilePidFile(
      path,
      Date.now,
      () => 1234,
      () => false,
    );
    await expect(pidFile.acquire()).rejects.toThrow(`${path}.recovery`);
    expect(await readPidFile(path)).toEqual(record);
  });

  it("recognizes a live owner published by the recovery winner", async () => {
    const path = await createPidFilePath();
    const winner = { pid: 4_321, startedAt: 2, token: "winner" };
    await writeFile(
      path,
      JSON.stringify({ pid: 9_999, startedAt: 1, token: "stale" }),
    );
    await writeFile(`${path}.recovery`, "");
    vi.mocked(delay).mockImplementationOnce(() =>
      writeFile(path, JSON.stringify(winner)),
    );
    const pidFile = new FilePidFile(
      path,
      Date.now,
      () => 1234,
      (pid) => pid === winner.pid,
    );
    await expect(pidFile.acquire()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
      record: winner,
    });
    expect(await readPidFile(path)).toEqual(winner);
    expect(await readFile(`${path}.recovery`, "utf8")).toBe("");
  });

  it("reads a lock that was still being published on the first startup read", async () => {
    const path = await createPidFilePath();
    const record = { pid: 9_999, startedAt: 1, token: "live" };
    await writeFile(path, "");
    vi.mocked(delay).mockImplementationOnce(() =>
      writeFile(path, JSON.stringify(record)),
    );
    const pidFile = new FilePidFile(
      path,
      Date.now,
      () => 1234,
      () => true,
    );
    await expect(pidFile.acquire()).rejects.toMatchObject({
      name: "DaemonAlreadyRunningError",
      record,
    });
    expect(await readPidFile(path)).toEqual(record);
  });

  it("preserves a lock when its PID cannot be probed", async () => {
    const path = await createPidFilePath();
    const record = { pid: 9_999, startedAt: 1, token: "unverifiable" };
    await writeFile(path, JSON.stringify(record));
    const pidFile = new FilePidFile(
      path,
      Date.now,
      () => 1234,
      () => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      },
    );
    await expect(pidFile.acquire()).rejects.toThrow(path);
    expect(await readPidFile(path)).toEqual(record);
  });

  it("does not report release success when the PID lock cannot be verified", async () => {
    const path = await createPidFilePath();
    const pidFile = new FilePidFile(
      path,
      Date.now,
      () => 1234,
      () => true,
    );
    const lock = await pidFile.acquire();
    await writeFile(path, "{");
    await expect(lock.release()).rejects.toThrow(path);
    expect(await readFile(path, "utf8")).toBe("{");
  });
});
