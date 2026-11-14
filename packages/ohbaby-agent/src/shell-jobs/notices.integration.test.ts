function requireBatch(value: string | null): string {
  if (value === null) throw new Error("Expected a notice batch");
  return value;
}
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  type DatabaseConnection,
  type DatabaseStatement,
} from "../services/database/index.js";
import { shellJobFixture } from "./fixtures/shell-job.js";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
  type ShellJobStore,
} from "./store.js";
import { renderShellJobNoticeBatch } from "./notice.js";

afterEach(closeDatabase);
describe.each(["memory", "database"] as const)("%s shell notices", (kind) => {
  function setup(): ShellJobStore {
    if (kind === "memory") return new InMemoryShellJobStore();
    initDatabase({ dbPath: ":memory:" });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
      )
      .run();
    return new DatabaseShellJobStore();
  }
  it("allocates disjoint frozen batches and keeps late result facts out of retries", async () => {
    const store = setup();
    for (let i = 0; i < 25; i++)
      await store.insert(
        shellJobFixture({
          jobId: `job-${String(i).padStart(2, "0")}`,
          status: "completed",
          resultReadyAt: 10,
          noticeState: "pending",
          outputTail: "original",
        }),
      );
    const batches = await Promise.all([
      store.allocateNoticeBatch({ sessionId: "s", contextScopeId: null }),
      store.allocateNoticeBatch({ sessionId: "s", contextScopeId: null }),
    ]);
    expect(batches.every(Boolean)).toBe(true);
    const first = store.getNoticeBatch(requireBatch(batches[0]));
    const second = store.getNoticeBatch(requireBatch(batches[1]));
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.jobId)).size).toBe(
      25,
    );
    const body = renderShellJobNoticeBatch(
      requireBatch(batches[0]),
      first.map((row) => row.noticePayload ?? ""),
    );
    await store.update(first[0].jobId, {
      outputTail: "later",
      cleanup: "confirmed",
    });
    expect(
      renderShellJobNoticeBatch(
        requireBatch(batches[0]),
        store
          .getNoticeBatch(requireBatch(batches[0]))
          .map((row) => row.noticePayload ?? ""),
      ),
    ).toBe(body);
    const binding = await Promise.all([
      store.bindNoticeBatch(requireBatch(batches[0]), null, "input-a"),
      store.bindNoticeBatch(requireBatch(batches[0]), null, "input-b"),
    ]);
    expect(binding.filter(Boolean)).toHaveLength(1);
    expect(
      await store.bindNoticeBatch(
        requireBatch(batches[0]),
        "input-a",
        "input-retry",
      ),
    ).toBe(true);
    expect(
      store
        .getNoticeBatch(requireBatch(batches[0]))
        .every(
          (row) =>
            row.noticeState === "accepted" &&
            row.noticeInputId === "input-retry",
        ),
    ).toBe(true);
  });
  it("claims a wake once and does not admit lost, foreign-Goal, or old child execution results", async () => {
    const store = setup();
    await store.insert(
      shellJobFixture({
        jobId: "lost",
        status: "lost",
        resultReadyAt: 10,
        noticeState: "pending",
      }),
    );
    await store.insert(
      shellJobFixture({
        jobId: "goal",
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
        goalId: "goal",
      }),
    );
    await store.insert(
      shellJobFixture({
        jobId: "child",
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
        contextScopeId: "child",
        rootRunId: "child-run",
      }),
    );
    expect(
      await store.allocateNoticeBatch(
        { sessionId: "s", contextScopeId: null },
        { wakeGoalId: null },
      ),
    ).toBeNull();
    expect(
      await store.allocateNoticeBatch({
        sessionId: "s",
        contextScopeId: "child",
        runId: "next-run",
      }),
    ).toBeNull();
    expect(
      await store.allocateNoticeBatch({
        sessionId: "s",
        contextScopeId: "child",
      }),
    ).toBeNull();
    const batch = requireBatch(
      await store.allocateNoticeBatch(
        { sessionId: "s", contextScopeId: null },
        { wakeGoalId: "goal" },
      ),
    );
    expect(await store.claimNoticeWake(batch, "bad-goal", null)).toBe(false);
    const claimed = await Promise.all([
      store.claimNoticeWake(batch, "wake-a", "goal"),
      store.claimNoticeWake(batch, "wake-b", "goal"),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(store.get("goal")?.noticeWakeRunId).toBe("wake-a");
    await store.bindNoticeBatch(batch, null, "input");
    expect(await store.claimNoticeWake(batch, "wake-again", "goal")).toBe(
      false,
    );
    expect(store.get("lost")?.noticeBatchId).toBeNull();
    expect(store.get("child")?.noticeBatchId).toBeNull();
  });
  it("pages only main-agent unclaimed ready sessions for startup checks", async () => {
    const store = setup();
    if (kind === "database")
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('t','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
    await store.insert(
      shellJobFixture({
        jobId: "lost",
        status: "lost",
        resultReadyAt: 10,
        noticeState: "pending",
      }),
    );
    await store.insert(
      shellJobFixture({
        jobId: "child",
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
        contextScopeId: "child",
      }),
    );
    expect(store.listWakeableNoticeSessions()).toEqual([]);
    await store.insert(
      shellJobFixture({
        jobId: "s-result",
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
      }),
    );
    await store.insert(
      shellJobFixture({
        jobId: "t-result",
        sessionId: "t",
        rootSessionId: "t",
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
      }),
    );
    expect(store.listWakeableNoticeSessions(undefined, 1)).toEqual(["s"]);
    expect(store.listWakeableNoticeSessions("s", 1)).toEqual(["t"]);
    const batch = requireBatch(
      await store.allocateNoticeBatch(
        { sessionId: "s", contextScopeId: null },
        { wakeGoalId: null },
      ),
    );
    await store.claimNoticeWake(batch, "wake", null);
    expect(store.listWakeableNoticeSessions()).toEqual(["t"]);
  });
  it("restores an unused opportunity only after rejection and before any acceptance", async () => {
    const store = setup();
    await store.insert(
      shellJobFixture({
        status: "completed",
        resultReadyAt: 10,
        noticeState: "pending",
      }),
    );
    const batch = requireBatch(
      await store.allocateNoticeBatch({
        sessionId: "s",
        contextScopeId: null,
      }),
    );
    await store.claimNoticeWake(batch, "rejected", null);
    expect(await store.releaseUnstartedNoticeWake(batch, "different")).toBe(
      false,
    );
    expect(await store.releaseUnstartedNoticeWake(batch, "rejected")).toBe(
      true,
    );
    expect(await store.claimNoticeWake(batch, "admitted", null)).toBe(true);
    if (kind === "database") {
      const { createDatabaseRunLedger } =
        await import("../runtime/run-ledger/database.js");
      await createDatabaseRunLedger().createPending({
        runId: "admitted",
        sessionId: "s",
        triggerSource: "user",
      });
      expect(await store.releaseUnstartedNoticeWake(batch, "admitted")).toBe(
        false,
      );
    }
    await store.bindNoticeBatch(batch, null, "input");
    expect(await store.releaseUnstartedNoticeWake(batch, "admitted")).toBe(
      false,
    );
  });
  it("publishes only committed local changes and isolates listener failures", async () => {
    const store = setup();
    const seen: string[] = [];
    const snapshots: unknown[] = [];
    const unsubscribe = store.subscribe((row) => {
      snapshots.push({ event: row, saved: store.get(row.jobId) });
      seen.push(row.jobId);
    });
    store.subscribe(() => {
      throw new Error("observer");
    });
    await store.insert(shellJobFixture());
    await expect(store.insert(shellJobFixture())).rejects.toThrow();
    expect(
      await store.compareAndUpdate(
        "job",
        { status: "lost" },
        { cleanup: "confirmed" },
      ),
    ).toBe(false);
    expect(seen).toEqual(["job"]);
    expect(snapshots).toEqual([
      { event: shellJobFixture(), saved: shellJobFixture() },
    ]);
    unsubscribe();
    await store.update("job", { status: "completed" });
    expect(seen).toEqual(["job"]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeSqliteConnection } from "../services/database/connection.js";

describe("database notice candidate read bounds", () => {
  function setupObservedStore(): {
    store: DatabaseShellJobStore;
    readSizes: number[];
  } {
    initDatabase({ dbPath: ":memory:" });
    const db = getDatabase();
    db.prepare(
      "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
    ).run();
    const readSizes: number[] = [];
    const observed: DatabaseConnection = {
      path: db.path,
      exec: (sql) => {
        db.exec(sql);
      },
      prepare<Row>(sql: string): DatabaseStatement<Row> {
        const statement = db.prepare<Row>(sql);
        return {
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
          all: (...params): Row[] => {
            const rows = statement.all(...params);
            readSizes.push(rows.length);
            return rows;
          },
        };
      },
      pragma: (name) => db.pragma(name),
      close: () => {
        db.close();
      },
    };
    return { store: new DatabaseShellJobStore({ db: observed }), readSizes };
  }

  it("loads at most one bounded batch of full records from SQLite", async () => {
    const { store, readSizes } = setupObservedStore();
    for (let i = 0; i < 25; i++)
      await store.insert(
        shellJobFixture({
          jobId: `job-${String(i)}`,
          status: "completed",
          resultReadyAt: i,
          noticeState: "pending",
          outputTail: "x".repeat(32768),
        }),
      );
    readSizes.length = 0;
    const batch = requireBatch(
      await store.allocateNoticeBatch({ sessionId: "s", contextScopeId: null }),
    );
    expect(store.getNoticeBatch(batch).length).toBeGreaterThan(0);
    expect(readSizes.length).toBeGreaterThan(0);
    expect(readSizes.every((size) => size <= 20)).toBe(true);
  });

  it.each(["goal", "child-run"] as const)(
    "does not let an ineligible %s prefix hide a later eligible result",
    async (kind) => {
      const { store, readSizes } = setupObservedStore();
      const contextScopeId = kind === "child-run" ? "child" : null;
      for (let i = 0; i < 25; i++)
        await store.insert(
          shellJobFixture({
            jobId: `old-${String(i)}`,
            contextScopeId,
            rootRunId: "old-run",
            goalId: kind === "goal" ? "old-goal" : null,
            status: "completed",
            resultReadyAt: i,
            noticeState: "pending",
          }),
        );
      await store.insert(
        shellJobFixture({
          jobId: "eligible",
          contextScopeId,
          rootRunId: "current-run",
          status: "completed",
          resultReadyAt: 100,
          noticeState: "pending",
        }),
      );
      readSizes.length = 0;
      const batch = requireBatch(
        await store.allocateNoticeBatch(
          { sessionId: "s", contextScopeId, runId: "current-run" },
          kind === "goal" ? { wakeGoalId: null } : {},
        ),
      );
      expect(store.getNoticeBatch(batch).map((row) => row.jobId)).toEqual([
        "eligible",
      ]);
      expect(readSizes.length).toBeGreaterThan(0);
      expect(readSizes.every((size) => size <= 20)).toBe(true);
    },
  );
});

it("keeps frozen batches disjoint across independent file-backed connections and reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shell-notice-"));
  const dbPath = join(directory, "agent.db");
  let peer: NodeSqliteConnection | undefined;
  try {
    initDatabase({ dbPath });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
      )
      .run();
    const first = new DatabaseShellJobStore();
    peer = new NodeSqliteConnection(dbPath);
    const second = new DatabaseShellJobStore({ db: peer });
    for (let i = 0; i < 25; i++)
      await first.insert(
        shellJobFixture({
          jobId: `job-${String(i)}`,
          status: "completed",
          resultReadyAt: 10,
          noticeState: "pending",
        }),
      );
    const batches = await Promise.all([
      first.allocateNoticeBatch({ sessionId: "s", contextScopeId: null }),
      second.allocateNoticeBatch({ sessionId: "s", contextScopeId: null }),
    ]);
    const a = first.getNoticeBatch(requireBatch(batches[0]));
    const b = second.getNoticeBatch(requireBatch(batches[1]));
    expect(a.length + b.length).toBe(25);
    expect(new Set([...a, ...b].map((row) => row.jobId)).size).toBe(25);
    const claim = await Promise.all([
      first.claimNoticeWake(requireBatch(batches[0]), "run-one", null),
      second.claimNoticeWake(requireBatch(batches[0]), "run-two", null),
    ]);
    expect(claim.filter(Boolean)).toHaveLength(1);
    const frozen = first
      .getNoticeBatch(requireBatch(batches[0]))
      .map((row) => row.noticePayload);
    peer.close();
    peer = new NodeSqliteConnection(dbPath);
    expect(
      new DatabaseShellJobStore({ db: peer })
        .getNoticeBatch(requireBatch(batches[0]))
        .map((row) => row.noticePayload),
    ).toEqual(frozen);
  } finally {
    peer?.close();
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
