import {
  mkdtemp,
  readFile,
  realpath,
  stat,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStorage,
  type StorageKey,
} from "../../services/storage/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import {
  DatabaseSubagentExecutionStore,
  InMemorySubagentExecutionStore,
  type ExecutionLookup,
} from "./execution-store.js";
import { createSubagentResultArtifacts } from "./result-artifacts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(
  output: string,
  requesterScopeId = "scope",
  rootSessionId = "parent",
) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "session-artifact-")),
  );
  directories.push(home);
  vi.stubEnv("OHBABY_HOME", home);
  const rootDir = join(home, "sessions");
  const store = new InMemorySubagentExecutionStore();
  const lookup = {
    executionId: "execution",
    parentSessionId: "parent",
    requesterScopeId,
  };
  await store.accept({
    ...lookup,
    requestId: "call",
    requesterRunId: "root-run",
    rootSessionId,
    rootRunId: "root-run",
    subagentId: "child",
    mode: "background",
    prompt: "report",
    createdAt: 1,
  });
  await store.bindChild(
    lookup,
    { sessionId: "child-session", contextScopeId: "child-scope" },
    2,
  );
  await store.finish(lookup, { status: "completed", output, completedAt: 3 });
  const storage = createStorage({ rootDir });
  const artifacts = createSubagentResultArtifacts({
    store,
    storage,
    rootDir,
    sessionExists: () => Promise.resolve(true),
  });
  return { rootDir, store, storage, artifacts, lookup };
}
describe("execution result artifacts", () => {
  it("includes the original task, stable name and unconsumed-message warning in automatic delivery", async () => {
    const { store, storage, rootDir, lookup } = await setup("final report");
    const artifacts = createSubagentResultArtifacts({
      store,
      storage,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      readDeliveryContext: () =>
        Promise.resolve({ name: "Researcher", unprocessedMessageCount: 2 }),
    });
    const inline = await artifacts.prepare(lookup);
    const long = await setup("final report".repeat(5000));
    const file = await createSubagentResultArtifacts({
      store: long.store,
      storage: long.storage,
      rootDir: long.rootDir,
      sessionExists: () => Promise.resolve(true),
      readDeliveryContext: () =>
        Promise.resolve({ name: "Researcher", unprocessedMessageCount: 2 }),
    }).prepare(long.lookup);
    for (const result of [inline, file]) {
      expect(result.body).toContain('name: "Researcher"');
      expect(result.body).toContain('task: "report"');
      expect(result.body).toContain("unprocessed_messages: 2 (not consumed");
    }
  });
  it.each([51199, 51200, 51201])(
    "preserves the complete UTF-8 report at %i bytes",
    async (size) => {
      const output = "中".repeat(Math.floor(size / 3)) + "a".repeat(size % 3);
      expect(Buffer.byteLength(output)).toBe(size);
      const { artifacts, lookup, rootDir } = await setup(output);
      const result = await artifacts.prepare(lookup);
      if (size <= 51200) {
        expect(result.artifact).toBeUndefined();
        expect(result.body.endsWith(output)).toBe(true);
        await expect(
          stat(
            join(rootDir, "parent", "subagents", "child", "execution.output"),
          ),
        ).rejects.toHaveProperty("code", "ENOENT");
      } else {
        expect(result.body).not.toContain(output.slice(0, 30));
        if (result.artifact?.state !== "ready")
          throw new Error("Missing complete artifact");
        expect(await readFile(result.artifact.path, "utf8")).toBe(output);
      }
    },
  );
  it("exports under the root session with private directories and keeps prior executions", async () => {
    const output = "root report\n".repeat(5000);
    const { artifacts, lookup, rootDir, store } = await setup(
      output,
      "scope",
      "owner",
    );
    const result = await artifacts.prepare(lookup);
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const expected = join(
      rootDir,
      "owner",
      "subagents",
      "child",
      "execution.output",
    );
    expect(result.artifact.path).toBe(expected);
    expect(result.body).toContain(
      `Complete result: ${expected}\nsizeBytes: ${String(Buffer.byteLength(output))}\nestimatedTokens: ${String(Math.ceil(Buffer.byteLength(output) / 4))}`,
    );
    expect(result.body).not.toContain(output.slice(0, 20));
    expect(await readFile(expected, "utf8")).toBe(output);
    if (process.platform !== "win32")
      for (const directory of [
        rootDir,
        join(rootDir, "owner"),
        join(rootDir, "owner", "subagents"),
        join(rootDir, "owner", "subagents", "child"),
      ])
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const next = { ...lookup, executionId: "next" };
    await store.accept({
      ...next,
      requestId: "call-next",
      requesterRunId: "root-run",
      rootSessionId: "owner",
      rootRunId: "root-run",
      subagentId: "child",
      mode: "background",
      prompt: "next",
      createdAt: 4,
    });
    await store.finish(next, {
      status: "completed",
      output: "next report".repeat(6000),
      completedAt: 5,
    });
    const second = await artifacts.prepare(next);
    expect(second.artifact?.state).toBe("ready");
    if (second.artifact?.state !== "ready")
      throw new Error("Missing next artifact");
    expect(second.artifact.path).toBe(
      join(rootDir, "owner", "subagents", "child", "next.output"),
    );
    expect(await readFile(expected, "utf8")).toBe(output);
    expect(await readFile(second.artifact.path, "utf8")).toBe(
      "next report".repeat(6000),
    );
  });
  it("regenerates ready records from old paths and reports a missing-file save failure truthfully", async () => {
    const output = "original report".repeat(4000);
    const { artifacts, lookup, rootDir, store, storage } = await setup(output);
    const old = join(rootDir, "old-location.output");
    await store.updateArtifact(
      lookup,
      { state: "ready", path: old, sizeBytes: Buffer.byteLength(output) },
      4,
    );
    const result = await artifacts.prepare(lookup);
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    expect(result.artifact.path).toBe(
      join(rootDir, "parent", "subagents", "child", "execution.output"),
    );
    expect((await store.get(lookup))?.artifact).toEqual(result.artifact);
    await rm(result.artifact.path);
    const failing = createSubagentResultArtifacts({
      store,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      storage: {
        ...storage,
        writeText: () => Promise.reject(new Error("disk unavailable")),
      },
    });
    const unavailable = await failing.prepare(lookup);
    expect(unavailable.artifact?.state).toBe("error");
    expect(unavailable.body).toContain(
      "complete result remains saved in the database, but its result file is unavailable",
    );
    expect(unavailable.body).not.toContain("Complete result:");
    expect((await store.get(lookup))?.output).toBe(output);
    expect((await artifacts.prepare(lookup)).artifact?.state).toBe("ready");
    expect(await readFile(result.artifact.path, "utf8")).toBe(output);
  });
  it("rejects a redirected subagents directory without writing a report into its target", async () => {
    const { artifacts, lookup, rootDir, store } = await setup(
      "private report".repeat(5000),
    );
    const target = join(rootDir, "outside");
    await mkdir(target, { recursive: true });
    await mkdir(join(rootDir, "parent"));
    await symlink(target, join(rootDir, "parent", "subagents"));
    const result = await artifacts.prepare(lookup);
    expect(result.artifact?.state).toBe("error");
    expect(result.body).not.toContain("Complete result:");
    expect((await store.get(lookup))?.artifact.state).toBe("error");
    await expect(
      readFile(join(target, "child", "execution.output")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });
  it("does not publish a file which Read rejects for a late NUL", async () => {
    const { artifacts, lookup } = await setup("a".repeat(52000) + "\0tail");
    expect((await artifacts.prepare(lookup)).artifact?.state).toBe("error");
  });
  it("does not publish an unreadable file as a usable entry", async () => {
    const { artifacts, lookup, store } = await setup("\0" + "x".repeat(52000));
    const result = await artifacts.prepare(lookup);
    expect(result.artifact?.state).toBe("error");
    expect(result.body).toContain("unsupported by Read");
    expect((await store.get(lookup))?.output?.length).toBe(52001);
  });
  it("cannot recreate an artifact after deletion races an atomic write", async () => {
    const { storage, store, rootDir, lookup } = await setup(
      "complete".repeat(8000),
    );
    let unblock: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const artifacts = createSubagentResultArtifacts({
      store,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      storage: {
        ...storage,
        writeText: async (key, text) => {
          entered();
          await gate;
          await storage.writeText(key, text);
        },
      },
    });
    const preparing = artifacts.prepare(lookup);
    await writing;
    await artifacts.deleteSession("parent");
    unblock();
    expect((await preparing).artifact?.state).toBe("deleted");
    expect(await storage.list(["parent", "subagents"])).toEqual([]);
    expect((await store.get(lookup))?.artifact).toEqual({
      state: "deleted",
      cleanupPending: false,
    });
  });
  it("keeps short original text inline and exports exact UTF8 above 50 KiB", async () => {
    const short = await setup("汉".repeat(17066));
    expect((await short.artifacts.prepare(short.lookup)).body).toContain(
      "汉".repeat(17066),
    );
    expect((await short.store.get(short.lookup))?.artifact.state).toBe("none");
    const text = "汉".repeat(17067);
    const long = await setup(text);
    const delivery = await long.artifacts.prepare(long.lookup);
    expect(delivery.body).not.toContain("汉");
    expect(delivery.artifact?.state).toBe("ready");
    if (delivery.artifact?.state !== "ready")
      throw new Error("Missing artifact");
    expect(await readFile(delivery.artifact.path, "utf8")).toBe(text);
    expect(delivery.artifact.sizeBytes).toBe(Buffer.byteLength(text));
  });
  it("rejects symlink substitutions and rebuilds manually removed files from DB", async () => {
    const { artifacts, lookup, rootDir } = await setup("original".repeat(8000));
    const result = await artifacts.prepare(lookup);
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const path = result.artifact.path;
    await rm(path);
    const rebuilt = await artifacts.prepare(lookup);
    expect(rebuilt.artifact?.state).toBe("ready");
    expect(await readFile(path, "utf8")).toBe("original".repeat(8000));
    await rm(path);
    const secret = join(rootDir, "unrelated.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path);
    const replaced = await artifacts.prepare(lookup);
    expect(replaced.artifact?.state).toBe("ready");
    expect(await readFile(path, "utf8")).toBe("original".repeat(8000));
    expect(await readFile(secret, "utf8")).toBe("secret");
  });
  it("retains complete DB body and returns explicit error after bounded export failure", async () => {
    const { store, storage, rootDir, lookup } = await setup(
      "large".repeat(11000),
    );
    let writes = 0;
    const artifacts = createSubagentResultArtifacts({
      store,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      storage: {
        ...storage,
        writeText: () => {
          writes++;
          return Promise.reject(new Error("disk full"));
        },
      },
    });
    const result = await artifacts.prepare(lookup);
    expect(writes).toBe(3);
    expect(result.artifact?.state).toBe("error");
    expect(result.body).toContain("disk full");
    expect(result.body).not.toContain(".output");
    expect((await store.get(lookup))?.output).toBe("large".repeat(11000));
  });
  it("durably revokes and cleans artifacts when a child session is deleted", async () => {
    const { store, artifacts, lookup, storage, rootDir } = await setup(
      "retained".repeat(8000),
    );
    const result = await artifacts.prepare(lookup);
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    await artifacts.deleteSession("child-session");
    expect((await store.get(lookup))?.artifact.state).toBe("deleted");
    const restarted = createSubagentResultArtifacts({
      store,
      storage,
      rootDir,
      sessionExists: () => Promise.resolve(true),
    });
    expect((await restarted.prepare(lookup)).body).toContain("deleted");
    await expect(readFile(result.artifact.path)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("reconciles unfinished exports and durable deletion intents after SQLite reopens without changing terminal executions", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "recovered-artifacts-")),
    );
    directories.push(home);
    vi.stubEnv("OHBABY_HOME", home);
    const rootDir = join(home, "sessions");
    const dbPath = join(home, "agent.db");
    const storage = createStorage({ rootDir });
    const body = "complete terminal report\n".repeat(3000);
    const lookupFor = (executionId: string): Required<ExecutionLookup> => ({
      executionId,
      parentSessionId: "parent",
      requesterScopeId: "scope",
    });
    const keyFor = (executionId: string): StorageKey => [
      "parent",
      "subagents",
      `child-${executionId}`,
      `${executionId}.output`,
    ];
    try {
      initDatabase({ dbPath });
      const store = new DatabaseSubagentExecutionStore({ db: getDatabase() });
      for (const executionId of ["unfinished", "revoked"]) {
        const lookup = lookupFor(executionId);
        await store.accept({
          ...lookup,
          requestId: `call-${executionId}`,
          requesterRunId: "requester-run",
          rootSessionId: "parent",
          rootRunId: "old-root-run",
          rootPromptId: "old-prompt",
          subagentId: `child-${executionId}`,
          mode: "background",
          prompt: "original task",
          createdAt: 1,
        });
        await store.bindChild(
          lookup,
          {
            sessionId: `session-${executionId}`,
            contextScopeId: `scope-${executionId}`,
          },
          2,
        );
        await store.start(lookup, `run-${executionId}`, 3);
        await store.finish(lookup, {
          status: "completed",
          output: body,
          completedAt: 4,
        });
        await storage.writeText(keyFor(executionId), "partial stale file");
      }
      await store.updateArtifact(
        lookupFor("unfinished"),
        { state: "preparing" },
        5,
      );
      // Simulate interruption after durable revocation and before file cleanup.
      await store.revokeSessionArtifacts("session-revoked", 5);
      const before = await store.list({ parentSessionId: "parent" });
      expect(
        before.find((record) => record.executionId === "revoked")?.artifact,
      ).toEqual({ state: "deleted", cleanupPending: true });
      expect(
        before.every((record) => record.delivery.state === "pending"),
      ).toBe(true);

      closeDatabase();
      initDatabase({ dbPath });
      const reopened = new DatabaseSubagentExecutionStore({
        db: getDatabase(),
      });
      expect(await reopened.list({ parentSessionId: "parent" })).toEqual(
        before,
      );
      const artifacts = createSubagentResultArtifacts({
        store: reopened,
        storage,
        rootDir,
        sessionExists: () => Promise.resolve(true),
        now: () => 10,
      });
      await expect(
        artifacts.prepare({
          ...lookupFor("unfinished"),
          requesterScopeId: "other",
        }),
      ).rejects.toThrow("requester scope");
      expect(
        await readFile(join(rootDir, ...keyFor("unfinished")), "utf8"),
      ).toBe("partial stale file");
      const result = await artifacts.prepare(lookupFor("unfinished"));
      if (result.artifact?.state !== "ready")
        throw new Error("Missing recovered artifact");
      expect(result.artifact.path).toBe(
        join(
          home,
          "sessions",
          "parent",
          "subagents",
          "child-unfinished",
          "unfinished.output",
        ),
      );
      expect(await readFile(result.artifact.path, "utf8")).toBe(body);
      expect(await artifacts.prepare(lookupFor("unfinished"))).toEqual(result);
      const deleted = await artifacts.prepare(lookupFor("revoked"));
      expect(deleted.artifact).toEqual({
        state: "deleted",
        cleanupPending: false,
      });
      expect(await artifacts.prepare(lookupFor("revoked"))).toEqual(deleted);
      await expect(
        readFile(join(rootDir, ...keyFor("revoked"))),
      ).rejects.toHaveProperty("code", "ENOENT");
      const after = await reopened.list({ parentSessionId: "parent" });
      expect(after).toHaveLength(2);
      for (const original of before) {
        expect(
          after.find((record) => record.executionId === original.executionId),
        ).toEqual({
          ...original,
          updatedAt: 10,
          artifact:
            original.executionId === "unfinished"
              ? result.artifact
              : deleted.artifact,
        });
      }
      closeDatabase();
      initDatabase({ dbPath });
      expect(
        await new DatabaseSubagentExecutionStore({ db: getDatabase() }).list({
          parentSessionId: "parent",
        }),
      ).toEqual(after);
    } finally {
      closeDatabase();
    }
  });
});
