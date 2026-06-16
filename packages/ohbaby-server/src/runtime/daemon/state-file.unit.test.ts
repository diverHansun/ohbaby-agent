import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonDaemonStateFile } from "./state-file.js";

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

  it("round-trips running connection metadata", async () => {
    const file = new JsonDaemonStateFile(statePath);

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

    await expect(file.read()).resolves.toEqual({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: 123,
      port: 4096,
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

    await expect(new JsonDaemonStateFile(statePath).read()).resolves.toBeUndefined();
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
