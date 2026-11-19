import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonDaemonStateFile } from "./state-file.js";

vi.mock("node:fs/promises", async (load) => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

describe("JsonDaemonStateFile", () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-state-"));
    statePath = join(dir, "daemon-state.json");
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("replaces the shutdown report and keeps its owner-only permissions", async () => {
    const file = new JsonDaemonStateFile(statePath);
    for (const pidToken of ["first", "second"]) {
      await file.writeShutdownReport({
        pid: 123,
        pidToken,
        recordedAt: 1,
        cleanup: { status: "confirmed", errors: [] },
      });
    }
    const reportPath = join(dir, "daemon-shutdown.json");
    expect(await readdir(dir)).toEqual(["daemon-shutdown.json"]);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      pidToken: "second",
    });
    if (process.platform !== "win32") {
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes its temporary file if renaming fails", async () => {
    await mkdir(statePath);
    await expect(
      new JsonDaemonStateFile(statePath).write({
        status: "stopped",
        updatedAt: 1,
      }),
    ).rejects.toMatchObject({ syscall: "rename" });
    expect(await readdir(dir)).toEqual(["daemon-state.json"]);
  });

  it("isolates concurrent temporary writes when one fails", async () => {
    let failRename: (() => void) | undefined;
    const failure = new Error("first publication failed");
    vi.mocked(rename).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failRename = (): void => {
            reject(failure);
          };
        }),
    );
    const file = new JsonDaemonStateFile(statePath);
    const first = file.write({ status: "stopping", updatedAt: 1 });
    const failed = expect(first).rejects.toBe(failure);
    try {
      await vi.waitFor(() => {
        expect(failRename).toBeDefined();
      });
      const [firstTemp] = await readdir(dir);
      await file.write({ status: "stopped", updatedAt: 2 });
      expect(firstTemp).toMatch(/\.tmp$/);
      expect(await readdir(dir)).toContain(firstTemp);
      expect((await file.read())?.updatedAt).toBe(2);
    } finally {
      failRename?.();
      await failed;
    }
    expect(await readdir(dir)).toEqual(["daemon-state.json"]);
  });

  it("only removes old reports and state temporary files", async () => {
    const preserved = [
      "daemon-state.json",
      "daemon-shutdown.json",
      "daemon.pid",
      "daemon-state.json.bak",
      "other.tmp",
      "daemon-state.json.shutdown-x.txt",
    ];
    const stale = [
      "daemon-state.json.shutdown-old.json",
      "daemon-state.json.shutdown-other.json",
      "daemon-state.json.123.tmp",
      "daemon-state.json.123.unique.tmp",
    ];
    await Promise.all(
      [...preserved, ...stale].map((name) => writeFile(join(dir, name), "")),
    );
    await new JsonDaemonStateFile(statePath).removeStaleFiles();
    expect((await readdir(dir)).sort()).toEqual(preserved.sort());
    await expect(
      new JsonDaemonStateFile(
        join(dir, "missing", "state.json"),
      ).removeStaleFiles(),
    ).resolves.toBeUndefined();
  });

  it("round-trips running connection metadata", async () => {
    const file = new JsonDaemonStateFile(statePath);

    await file.write({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: 123,
      pidToken: "pid_token_1",
      port: 4096,
      scopeRoot: "/tmp/repo",
      startedAt: 1_000,
      status: "running",
      updatedAt: 1_001,
    });

    await expect(file.read()).resolves.toEqual({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: 123,
      pidToken: "pid_token_1",
      port: 4096,
      scopeRoot: "/tmp/repo",
      startedAt: 1_000,
      status: "running",
      updatedAt: 1_001,
    });
  });

  it("ignores running state without connection metadata", async () => {
    await writeFile(
      statePath,
      `${JSON.stringify({ pid: 123, status: "running", updatedAt: 1_001 })}\n`,
      "utf8",
    );

    await expect(
      new JsonDaemonStateFile(statePath).read(),
    ).resolves.toBeUndefined();
  });

  it("keeps legacy running state without packageVersion readable for fail-closed reuse", async () => {
    await writeFile(
      statePath,
      `${JSON.stringify({
        authToken: "token_1",
        host: "127.0.0.1",
        pid: 123,
        port: 4096,
        status: "running",
        updatedAt: 1_001,
      })}\n`,
      "utf8",
    );

    await expect(new JsonDaemonStateFile(statePath).read()).resolves.toEqual({
      authToken: "token_1",
      host: "127.0.0.1",
      pid: 123,
      port: 4096,
      status: "running",
      updatedAt: 1_001,
    });
  });

  it("keeps lifecycle-only stopped state readable", async () => {
    const file = new JsonDaemonStateFile(statePath);

    await file.write({
      pid: 123,
      startedAt: 1_000,
      status: "stopped",
      updatedAt: 1_002,
    });

    await expect(file.read()).resolves.toEqual({
      pid: 123,
      startedAt: 1_000,
      status: "stopped",
      updatedAt: 1_002,
    });
  });

  it("writes daemon state with owner-only file permissions on POSIX", async () => {
    if (process.platform === "win32") {
      return;
    }
    const file = new JsonDaemonStateFile(statePath);
    const previousUmask = process.umask(0);

    try {
      await file.write({
        authToken: "token_1",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 123,
        port: 4096,
        startedAt: 1_000,
        status: "running",
        updatedAt: 1_001,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });
});
