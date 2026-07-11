import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readServeCoexistenceNotice } from "./serve-awareness.js";

describe("readServeCoexistenceNotice", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("returns a notice only for a live matching-version global server", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "ohbaby-awareness-"));
    cleanup.push(homeDirectory);
    const serverDirectory = join(homeDirectory, ".ohbaby", "server");
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
      join(serverDirectory, "daemon.pid"),
      JSON.stringify({ pid: process.pid, startedAt: 1, token: "pid-token" }),
      "utf8",
    );
    await writeFile(
      join(serverDirectory, "daemon-state.json"),
      JSON.stringify({
        authToken: "auth-token",
        host: "127.0.0.1",
        packageVersion: "0.1.7",
        pid: process.pid,
        pidToken: "pid-token",
        port: 4567,
        status: "running",
        updatedAt: 2,
      }),
      "utf8",
    );
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ok: true, packageVersion: "0.1.7" })),
    );

    await expect(
      readServeCoexistenceNotice({
        fetch: fetchImpl,
        homeDirectory,
        packageVersion: "0.1.7",
      }),
    ).resolves.toContain("http://127.0.0.1:4567");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/health",
      expect.objectContaining({
        headers: { authorization: "Bearer auth-token" },
      }),
    );
  });

  it("fails closed when state version does not match the CLI", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "ohbaby-awareness-"));
    cleanup.push(homeDirectory);
    const serverDirectory = join(homeDirectory, ".ohbaby", "server");
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(
      join(serverDirectory, "daemon.pid"),
      JSON.stringify({ pid: process.pid, startedAt: 1, token: "pid-token" }),
      "utf8",
    );
    await writeFile(
      join(serverDirectory, "daemon-state.json"),
      JSON.stringify({
        host: "127.0.0.1",
        packageVersion: "0.1.6",
        pid: process.pid,
        pidToken: "pid-token",
        port: 4567,
        status: "running",
        updatedAt: 2,
      }),
      "utf8",
    );

    await expect(
      readServeCoexistenceNotice({
        fetch: vi.fn(),
        homeDirectory,
        packageVersion: "0.1.7",
      }),
    ).resolves.toBeUndefined();
  });
});
