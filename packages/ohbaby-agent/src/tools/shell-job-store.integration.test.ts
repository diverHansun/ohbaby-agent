import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteConnection } from "../services/database/connection.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  runWriteTransaction,
} from "../services/database/index.js";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
  type ShellJobStore,
  type ShellJobRecord,
} from "./shell-job-store.js";

const record: ShellJobRecord = {
  jobId: "job",
  sessionId: "session",
  contextScopeId: null,
  rootSessionId: "session",
  workspaceKey: null,
  rootRunId: "root",
  runId: "run",
  messageId: "message",
  callId: "call",
  mode: "background",
  command: "echo hello",
  description: null,
  cwd: "/tmp",
  shell: "/bin/sh",
  timeoutMs: null,
  status: null,
  stopReason: null,
  exitCode: null,
  signal: null,
  error: null,
  pid: null,
  pgid: null,
  processStartToken: null,
  recoveryClaim: null,
  ownerPid: null,
  ownerId: null,
  ownerStartToken: null,
  goalId: null,
  createdAt: 1,
  startedAt: null,
  promotedAt: null,
  endedAt: null,
  settledAt: null,
  resultReadyAt: null,
  outputPath: null,
  outputBytes: 0,
  outputTruncated: false,
  outputTail: null,
  outputCheckpointAt: null,
  outputComplete: null,
  cleanup: null,
  trackingReleasedAt: null,
  noticeState: null,
  noticeBatchId: null,
  noticePayload: null,
  noticeInputId: null,
  noticeWakeRunId: null,
};

afterEach(() => {
  closeDatabase();
});

function seedSession(): void {
  getDatabase()
    .prepare(
      "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
    )
    .run();
}

const foreground: ShellJobRecord = {
  ...record,
  mode: "foreground",
  status: "running",
  startedAt: 2,
};

describe.each(["memory", "database"] as const)("%s shell job store", (kind) => {
  let store: ShellJobStore;
  beforeEach(() => {
    if (kind === "database") {
      initDatabase({ dbPath: ":memory:" });
      seedSession();
    }
    store =
      kind === "database"
        ? new DatabaseShellJobStore()
        : new InMemoryShellJobStore();
  });

  it("reserves owner-specific capacity atomically and rechecks admission before inserting", async () => {
    const result = await Promise.allSettled([
      store.insert(record, { maxBackgroundJobs: 1 }),
      store.insert({ ...record, jobId: "overflow" }, { maxBackgroundJobs: 1 }),
    ]);
    expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(store.listByOwner("session", null)).toHaveLength(1);
    await store.insert(
      { ...record, jobId: "child", contextScopeId: "child" },
      { maxBackgroundJobs: 1 },
    );
    await store.insert(
      { ...record, jobId: "foreground", mode: "foreground" },
      { maxBackgroundJobs: 1 },
    );
    await expect(
      store.insert(
        { ...record, jobId: "closed", contextScopeId: "other" },
        {
          assertAdmitted: () => {
            throw new Error("closed");
          },
        },
      ),
    ).rejects.toThrow("closed");
    expect(store.get("closed")).toBeNull();
    await store.update("child", {
      status: "cancelled",
      cleanup: "unconfirmed",
    });
    await expect(
      store.insert(
        { ...record, jobId: "child-overflow", contextScopeId: "child" },
        { maxBackgroundJobs: 1 },
      ),
    ).rejects.toMatchObject({ code: "SHELL_JOB_CAPACITY_LIMIT" });
    await store.update("child", { trackingReleasedAt: 20 });
    await expect(
      store.insert(
        { ...record, jobId: "child-next", contextScopeId: "child" },
        { maxBackgroundJobs: 1 },
      ),
    ).resolves.toBeUndefined();
  });
  it("commits the first background checkpoint before reporting promotion", async () => {
    await store.insert(foreground);
    let runtimeMode = "foreground";
    const observed: string[] = [];
    store.subscribe((row) => observed.push(`${row.mode}:${runtimeMode}`));
    const promotion = store.promote("job", {
      maxBackgroundJobs: 1,
      prepare: () => ({
        promotedAt: 4,
        outputBytes: 10,
        outputTail: "last bytes",
        outputCheckpointAt: 4,
      }),
      onCommitted: () => {
        runtimeMode = store.get("job")?.mode ?? "missing";
      },
    });
    await expect(promotion).resolves.toBe(true);
    expect(observed).toEqual(["background:background"]);
    expect(store.get("job")).toMatchObject({
      mode: "background",
      startedAt: 2,
      promotedAt: 4,
      outputBytes: 10,
      outputTail: "last bytes",
      outputCheckpointAt: 4,
    });
  });

  it("skips promotion when the runtime recheck declines, even at capacity", async () => {
    await store.insert(foreground);
    await store.insert({ ...record, jobId: "active" });
    let committed = false;
    await expect(
      store.promote("job", {
        maxBackgroundJobs: 1,
        prepare: () => null,
        onCommitted: () => {
          committed = true;
        },
      }),
    ).resolves.toBe(false);
    expect(committed).toBe(false);
    expect(store.get("job")).toMatchObject({ mode: "foreground" });
  });

  it("uses row CAS to exclude abandoned tasks from recovery and finds NULL startup reservations", async () => {
    await store.insert(record);
    await store.update("job", { command: undefined });
    expect(store.get("job")?.command).toBe(record.command);
    await expect(store.compareAndUpdate("job", {}, {})).rejects.toThrow(
      "requires an update",
    );
    expect(store.listUnsettled()).toHaveLength(1);
    expect(store.listUnsettled("another-root")).toHaveLength(0);
    const results = await Promise.all([
      store.compareAndUpdate(
        "job",
        { recoveryClaim: null, trackingReleasedAt: null },
        { recoveryClaim: "actor" },
      ),
      store.compareAndUpdate(
        "job",
        { recoveryClaim: null, trackingReleasedAt: null },
        { trackingReleasedAt: 10 },
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.update("job", { recoveryClaim: null, trackingReleasedAt: 10 });
    expect(
      await store.compareAndUpdate(
        "job",
        { trackingReleasedAt: null },
        { recoveryClaim: "late" },
      ),
    ).toBe(false);
    expect(store.listUnsettled()).toHaveLength(0);
    await store.update("job", {
      trackingReleasedAt: null,
      status: "completed",
      cleanup: "confirmed",
      settledAt: 11,
      outputComplete: false,
    });
    expect(store.listUnsettled()).toHaveLength(0);
  });
  it("persists placeholders, lifecycle updates, and owner-scoped history", async () => {
    await store.insert(record);
    await store.update("job", { status: "running", pid: 42, startedAt: 2 });
    await store.update("job", {
      status: "completed",
      exitCode: 0,
      resultReadyAt: 3,
      outputTail: "hello",
    });
    expect(store.get("job")).toMatchObject({
      status: "completed",
      pid: 42,
      outputTail: "hello",
    });
    expect(store.listByRootRun("root")).toHaveLength(1);
    expect(store.listByRootRun("other")).toHaveLength(0);
    expect(store.listByOwner("session", null)).toHaveLength(1);
    expect(store.listByOwner("session", "other")).toHaveLength(0);
  });
});

it("rereads a job after queued database writes before attempting promotion", async () => {
  initDatabase({ dbPath: ":memory:" });
  seedSession();
  const store = new DatabaseShellJobStore();
  await store.insert(foreground);
  let prepared = false;
  let committed = false;
  const [, promoted] = await Promise.all([
    store.update("job", { status: "cancelled", stopReason: "user" }),
    store.promote("job", {
      maxBackgroundJobs: 1,
      prepare: () => {
        prepared = true;
        return { promotedAt: 4 };
      },
      onCommitted: () => {
        committed = true;
      },
    }),
  ]);
  expect(promoted).toBe(false);
  expect(prepared).toBe(false);
  expect(committed).toBe(false);
  expect(store.get("job")).toMatchObject({
    mode: "foreground",
    status: "cancelled",
  });
});

it("serializes owner capacity across connections and runs the hook after COMMIT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-promote-"));
  const dbPath = join(directory, "agent.db");
  initDatabase({ dbPath });
  const second = new NodeSqliteConnection(dbPath);
  try {
    seedSession();
    const primary = new DatabaseShellJobStore();
    const other = new DatabaseShellJobStore({ db: second });
    await primary.insert(foreground);
    await primary.insert({ ...foreground, jobId: "other" });
    await primary.insert({
      ...record,
      jobId: "child",
      contextScopeId: "child",
    });
    const observed: (string | undefined)[] = [];
    const results = await Promise.allSettled([
      primary.promote("job", {
        maxBackgroundJobs: 1,
        prepare: () => ({ promotedAt: 4 }),
        onCommitted: () => {
          observed.push(other.get("job")?.mode);
        },
      }),
      other.promote("other", {
        maxBackgroundJobs: 1,
        prepare: () => ({ promotedAt: 4 }),
        onCommitted: () => {
          observed.push(primary.get("other")?.mode);
        },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: true },
    ]);
    expect(
      results.find((result) => result.status === "rejected")?.reason,
    ).toMatchObject({ code: "SHELL_JOB_CAPACITY_LIMIT" });
    expect(observed).toEqual(["background"]);
    expect(
      primary
        .listByOwner("session", null)
        .map((row) => row.mode)
        .sort(),
    ).toEqual(["background", "foreground"]);
  } finally {
    second.close();
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not attempt rollback or repeat a committed operation when its hook throws", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  const commands: string[] = [];
  const connection = {
    path: db.path,
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),
    close: db.close.bind(db),
    exec(sql: string): void {
      commands.push(sql);
      db.exec(sql);
    },
  };
  const error = new Error("hook failure");
  await expect(
    runWriteTransaction(
      connection,
      (tx) => {
        tx.exec("CREATE TABLE committed(x)");
      },
      () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  expect(commands.filter((sql) => !sql.startsWith("PRAGMA"))).toEqual([
    "BEGIN IMMEDIATE",
    "CREATE TABLE committed(x)",
    "COMMIT",
  ]);
  expect(db.prepare("SELECT * FROM committed").all()).toEqual([]);
});
