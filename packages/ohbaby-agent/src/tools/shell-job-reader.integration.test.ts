import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  appendFile,
  truncate,
  realpath,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { ShellJobRegistry } from "./shell-job-registry.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShellJobReader,
  encodeShellJobCursor,
  decodeShellJobCursor,
} from "./shell-job-reader.js";
import { InMemoryShellJobStore } from "./shell-job-store.js";
import { shellJobFixture } from "./fixtures/shell-job.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(): Promise<{
  store: InMemoryShellJobStore;
  reader: ShellJobReader;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-shell-reader-"));
  directories.push(directory);
  const path = join(await realpath(directory), "job.log");
  const store = new InMemoryShellJobStore();
  await store.insert(shellJobFixture({ outputPath: path }));
  const reader = new ShellJobReader({
    store,
    management: () =>
      Promise.resolve({ managedByCurrentBackend: false, canStop: false }),
  });
  return { store, reader, path };
}
const target = { rootSessionId: "s", jobId: "job" };
describe("authorized shell job reads", () => {
  it("shares identical owner checks only within one list page", async () => {
    const { store } = await setup();
    await store.insert(shellJobFixture({ jobId: "second" }));
    await store.insert(
      shellJobFixture({ jobId: "third", ownerStartToken: "different" }),
    );
    const management = vi.fn(() =>
      Promise.resolve({
        managedByCurrentBackend: false,
        canStop: false,
      }),
    );
    const reader = new ShellJobReader({ store, management });
    await reader.list({ rootSessionId: "s" });
    expect(management).toHaveBeenCalledTimes(2);
    await reader.list({ rootSessionId: "s" });
    expect(management).toHaveBeenCalledTimes(4);
    await reader.output(target);
    expect(management).toHaveBeenCalledTimes(5);
  });

  it("isolates roots and binds cursor filters without treating the cursor as authority", async () => {
    const { store, reader } = await setup();
    await store.insert(
      shellJobFixture({ jobId: "second", createdAt: 5, startedAt: 5 }),
    );
    const first = await reader.list({ rootSessionId: "s", limit: 1 });
    expect(first.rows.map((row) => row.jobId)).toEqual(["second"]);
    expect(first.rows[0]).toMatchObject({
      managedByCurrentBackend: false,
      canStop: false,
    });
    expect(first.rows[0]).not.toHaveProperty("ownerStartToken");
    expect(first.rows[0]).not.toHaveProperty("pid");
    const next = await reader.list({
      rootSessionId: "s",
      limit: 100,
      cursor: first.nextCursor,
    });
    expect(next.rows.map((row) => row.jobId)).toEqual(["job"]);
    await expect(
      reader.list({ rootSessionId: "side", cursor: first.nextCursor }),
    ).rejects.toThrow("cursor");
    await expect(
      reader.list({
        rootSessionId: "s",
        statuses: ["cancelled"],
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("cursor");
    await expect(
      reader.output({ ...target, rootSessionId: "side" }),
    ).rejects.toMatchObject({ code: "SHELL_JOB_NOT_FOUND" });
    await expect(
      reader.log({ ...target, rootSessionId: "side" }),
    ).rejects.toMatchObject({ code: "SHELL_JOB_NOT_FOUND" });
    const scope = {
      rootSessionId: "s",
    };
    const cursor = encodeShellJobCursor(
      scope,
      { search: "", owner: { kind: "main" } },
      { attention: 1, at: 1, jobId: "job" },
    );
    expect(() =>
      decodeShellJobCursor(cursor, scope, {
        search: "",
        owner: { kind: "subagents" },
      }),
    ).toThrow("cursor");
    await expect(
      reader.list({ rootSessionId: "s", cursor: "bad==" }),
    ).rejects.toThrow("cursor");
  });
  it("distinguishes missing logs from empty output and exposes durable checkpoint facts without consuming notices", async () => {
    const { store, reader, path } = await setup();
    await store.update("job", {
      noticeState: "pending",
      outputTail: "",
      outputBytes: 0,
    });
    expect(await reader.output(target)).toMatchObject({
      source: "saved",
      tailAvailable: true,
      output: "",
      logAvailable: false,
      outputCheckpointAt: 3,
    });
    await writeFile(path, "");
    expect(await reader.output(target)).toMatchObject({
      output: "",
      logAvailable: true,
    });
    expect(await reader.log(target)).toMatchObject({
      available: true,
      bytesRead: 0,
      hasMore: false,
    });
    expect(store.get("job")?.noticeState).toBe("pending");
    await store.update("job", { mode: "foreground", outputTail: null });
    expect(await reader.output(target)).toMatchObject({
      tailAvailable: false,
      output: "",
    });
    await store.update("job", { status: null });
    expect(await reader.list({ rootSessionId: "s" })).toMatchObject({
      rows: [],
    });
    await expect(reader.output(target)).rejects.toMatchObject({
      code: "SHELL_JOB_NOT_READY",
    });
  });
  it("returns a bounded real tail from live facts and keeps the durable checkpoint separate", async () => {
    const { store } = await setup();
    const live = new ShellJobReader({
      store,
      management: () =>
        Promise.resolve({ managedByCurrentBackend: true, canStop: true }),
      readCurrent: (record) => ({
        record: {
          ...record,
          outputTail: "开".repeat(14000) + "end",
          outputBytes: 42003,
        },
        source: "live",
        sampledAt: 99,
      }),
    });
    const output = await live.output(target);
    expect(output).toMatchObject({
      source: "live",
      sampledAt: 99,
      outputCheckpointAt: 3,
      outputBytes: 42003,
    });
    expect(output.output.endsWith("end")).toBe(true);
    expect(output.output).not.toContain("�");
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(32768);
    expect(store.get("job")?.outputTail).toBe("checkpoint");
  });
  it("reads a real Registry log while its background command is still running", async () => {
    const { store, path } = await setup();
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    });
    const registry = new ShellJobRegistry({
      store,
      killTree: () => ({ status: "confirmed" }),
      probeTree: () => "stopped",
    });
    const started = await registry.start({
      child: () => child as unknown as ChildProcess,
      sessionId: "s",
      background: true,
      timeoutMs: null,
      outputDirectory: path.slice(0, path.lastIndexOf("/")),
    });
    const reader = new ShellJobReader({
      store,
      readCurrent: (row) =>
        registry.getCurrentRecord(
          row.jobId,
          row.sessionId,
          row.contextScopeId ?? undefined,
        ),
      management: () =>
        Promise.resolve({ managedByCurrentBackend: true, canStop: true }),
    });
    try {
      child.stdout.emit("data", Buffer.from("live log"));
      const query = { rootSessionId: "s", jobId: started.jobId };
      expect(store.get(started.jobId)?.outputPath).toBeTruthy();
      expect(await reader.output(query)).toMatchObject({
        source: "live",
        output: "live log",
        logAvailable: true,
      });
      expect(await reader.log(query)).toMatchObject({
        available: true,
        text: "live log",
      });
      child.emit("close", 0, null);
    } finally {
      await registry.dispose();
    }
  });
  it("uses bounded byte offsets across UTF-8, growth, truncation and EOF", async () => {
    const { store, reader, path } = await setup();
    await writeFile(path, "你abc");
    expect(await reader.log({ ...target, maxBytes: 3 })).toMatchObject({
      text: "你",
      bytesRead: 3,
      nextOffset: 3,
      hasMore: true,
    });
    expect(
      await reader.log({ ...target, offset: 1, maxBytes: 2 }),
    ).toMatchObject({ bytesRead: 2, nextOffset: 3 });
    expect(await reader.log({ ...target, offset: 3 })).toMatchObject({
      text: "abc",
      nextOffset: 6,
      hasMore: false,
    });
    await appendFile(path, "tail");
    expect(await reader.log({ ...target, offset: 6 })).toMatchObject({
      text: "tail",
      nextOffset: 10,
    });
    await truncate(path, 0);
    expect(await reader.log({ ...target, offset: 10 })).toMatchObject({
      available: true,
      text: "",
      nextOffset: 10,
      hasMore: false,
    });
    await writeFile(path, "x".repeat(70000));
    await store.update("job", { outputTruncated: true });
    expect(await reader.log({ ...target, maxBytes: 65536 })).toMatchObject({
      bytesRead: 65536,
      nextOffset: 65536,
      hasMore: true,
      truncated: true,
    });
    for (const input of [
      { offset: -1 },
      { offset: 0.5 },
      { maxBytes: 65537 },
      { maxBytes: 0 },
    ])
      await expect(reader.log({ ...target, ...input })).rejects.toThrow(
        "range",
      );
  });
  it("rejects directories, symlinks and FIFOs without blocking or following client paths", async () => {
    const { reader, path } = await setup();
    await symlink(tmpdir(), path);
    expect(await reader.log(target)).toMatchObject({
      available: false,
      bytesRead: 0,
    });
    await rm(path);
    await writeFile(path + ".real", "secret");
    await symlink(path + ".real", path);
    expect(await reader.log(target)).toMatchObject({
      available: false,
      bytesRead: 0,
    });
    await rm(path);
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path]);
      expect(await reader.log(target)).toMatchObject({
        available: false,
        bytesRead: 0,
      });
    }
  });
  it("rejects a replaced parent directory even when its new target contains a regular file", async () => {
    const { reader, path } = await setup();
    await writeFile(path, "original");
    const parent = path.slice(0, path.lastIndexOf("/"));
    const replacement = parent + "-replacement";
    directories.push(replacement);
    await mkdir(replacement);
    await writeFile(join(replacement, "job.log"), "other-session-secret");
    await rm(parent, { recursive: true });
    await symlink(replacement, parent);
    expect(await reader.log(target)).toMatchObject({
      available: false,
      text: "",
    });
    expect(await reader.output(target)).toMatchObject({ logAvailable: false });
  });
  it("rechecks ownership and cancellation after asynchronous row projection", async () => {
    const { store, path } = await setup();
    await writeFile(path, "data");
    const controller = new AbortController();
    const cancelled = new ShellJobReader({
      store,
      management: () => {
        controller.abort();
        return Promise.resolve({
          managedByCurrentBackend: false,
          canStop: false,
        });
      },
    });
    await expect(
      cancelled.output({ ...target, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const changed = new ShellJobReader({
      store,
      management: async () => {
        await store.update("job", { outputPath: null });
        return { managedByCurrentBackend: false, canStop: false };
      },
    });
    await expect(changed.output(target)).rejects.toMatchObject({
      code: "SHELL_JOB_NOT_READY",
    });
    expect(store.get("job")?.status).toBe("running");
  });
  it("propagates read cancellation without stopping or changing the task", async () => {
    const { store, reader, path } = await setup();
    await writeFile(path, "data");
    const controller = new AbortController();
    controller.abort();
    for (const operation of [
      reader.output({ ...target, signal: controller.signal }),
      reader.log({ ...target, signal: controller.signal }),
      reader.list({ rootSessionId: "s", signal: controller.signal }),
    ])
      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(store.get("job")?.status).toBe("running");
  });
  it("rejects malformed filters before refresh probes", async () => {
    const { store } = await setup();
    const refreshRoot = vi.fn(() => Promise.resolve());
    const reader = new ShellJobReader({
      store,
      refreshRoot,
      management: () =>
        Promise.resolve({ managedByCurrentBackend: false, canStop: false }),
    });
    await expect(
      reader.list({ rootSessionId: "s", limit: 101 }),
    ).rejects.toThrow();
    await expect(
      reader.list({ rootSessionId: "s", search: "x".repeat(1025) }),
    ).rejects.toThrow();
    expect(refreshRoot).not.toHaveBeenCalled();
  });
});
