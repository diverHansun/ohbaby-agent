import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
  type ShellJobRecord,
} from "./shell-job-store.js";

const record: ShellJobRecord = {
  jobId: "job",
  sessionId: "session",
  contextScopeId: null,
  rootSessionId: "session",
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
describe.each(["memory", "database"] as const)("%s shell job store", (kind) => {
  it("reserves owner-specific capacity atomically and rechecks admission before inserting", async () => {
    if (kind === "database") {
      initDatabase({ dbPath: ":memory:" });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
    }
    const store =
      kind === "database"
        ? new DatabaseShellJobStore()
        : new InMemoryShellJobStore();
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
  it("uses row CAS to exclude abandoned tasks from recovery and finds NULL startup reservations", async () => {
    if (kind === "database") {
      initDatabase({ dbPath: ":memory:" });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
    }
    const store =
      kind === "database"
        ? new DatabaseShellJobStore()
        : new InMemoryShellJobStore();
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
    if (kind === "database") {
      initDatabase({ dbPath: ":memory:" });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('session','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
    }
    const store =
      kind === "database"
        ? new DatabaseShellJobStore()
        : new InMemoryShellJobStore();
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
