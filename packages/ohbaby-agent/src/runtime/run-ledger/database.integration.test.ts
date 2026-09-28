import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
  type DatabaseConnection,
} from "../../services/database/index.js";
import { NodeSqliteConnection } from "../../services/database/connection.js";
import {
  createDatabaseRunLedger,
  InvalidRunTransitionError,
  RunLedgerNotFoundError,
  SessionRunBusyError,
} from "./index.js";

const cleanupPaths: string[] = [];

it.each([0, -1, 1.5, NaN, Infinity])(
  "preserves unknown invalid owner PID %s and refuses a competing claim",
  async (ownerPid) => {
    const probe = vi.fn(() => false);
    const ledger = createDatabaseRunLedger({ isOwnerAlive: probe });
    await ledger.createPending({
      runId: "unknown",
      sessionId: "session_1",
      triggerSource: "user",
      ownerId: "old",
      ownerPid,
    });
    await expect(ledger.recoverOrphanedRuns()).resolves.toEqual({
      updatedCount: 0,
    });
    await expect(ledger.markInterrupted()).resolves.toEqual({
      updatedCount: 0,
    });
    await expect(
      ledger.claimPendingRun({
        runId: "new",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(SessionRunBusyError);
    expect((await ledger.get("unknown"))?.status).toBe("pending");
    expect(probe).not.toHaveBeenCalled();
    await expect(
      ledger.recoverOrphanedRuns({ recoverUnknownOwner: true }),
    ).resolves.toEqual({ updatedCount: 1 });
  },
);

function insertSession(id = "session_1"): void {
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "project_1", "D:/repo", "default", id, "active", 1, 1, 0, "{}");
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-run-ledger-db-"));
  cleanupPaths.push(directory);
  initDatabase({ dbPath: join(directory, "agent.db") });
  insertSession();
  insertSession("session_2");
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createDatabaseRunLedger", () => {
  it("records run lifecycle transitions", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });

    await expect(
      ledger.createPending({
        runId: "run_1",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({ status: "pending", createdAt: 1_000 });
    await expect(ledger.markRunning("run_1")).resolves.toMatchObject({
      status: "running",
      startedAt: 2_000,
    });
    await expect(ledger.markSucceeded("run_1")).resolves.toMatchObject({
      status: "succeeded",
      endedAt: 3_000,
    });
  });

  it("persists structured failure details and tolerates corrupt legacy data", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    await ledger.createPending({
      runId: "run_failed",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("run_failed");
    await expect(
      ledger.markFailed("run_failed", "rate limited", {
        code: "PROVIDER_HTTP_429",
        message: "rate limited",
        retryable: true,
        source: "provider",
        statusCode: 429,
      }),
    ).resolves.toMatchObject({
      error: "rate limited",
      errorData: {
        code: "PROVIDER_HTTP_429",
        retryable: true,
        statusCode: 429,
      },
    });

    getDatabase()
      .prepare(
        `UPDATE ${schema.runLedger.tableName}
         SET error_data = 'not-json' WHERE run_id = 'run_failed'`,
      )
      .run();
    await expect(ledger.get("run_failed")).resolves.toMatchObject({
      error: "rate limited",
      errorData: undefined,
    });
  });

  it("rejects duplicate ids, missing records, and invalid transitions", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    await ledger.createPending({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(
      ledger.createPending({
        runId: "run_1",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(InvalidRunTransitionError);
    await expect(ledger.markSucceeded("missing")).rejects.toBeInstanceOf(
      RunLedgerNotFoundError,
    );
    await ledger.markRunning("run_1");
    await ledger.markSucceeded("run_1");
    await expect(ledger.markRunning("run_1")).rejects.toBeInstanceOf(
      InvalidRunTransitionError,
    );
  });

  it("claims a pending run only when the session has no active run", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });

    await expect(
      ledger.claimPendingRun({
        runId: "run_1",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({
      runId: "run_1",
      sessionId: "session_1",
      status: "pending",
    });
    await expect(
      ledger.claimPendingRun({
        runId: "run_2",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(SessionRunBusyError);
    await expect(
      ledger.claimPendingRun({
        runId: "run_other",
        sessionId: "session_2",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({
      runId: "run_other",
      sessionId: "session_2",
      status: "pending",
    });
  });

  it("allows active runs in one session when context scopes differ", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    insertSession("child_1");

    await ledger.claimPendingRun({
      contextScopeId: "subagent_1",
      runId: "run_1",
      sessionId: "child_1",
      triggerSource: "user",
    });
    await expect(
      ledger.claimPendingRun({
        contextScopeId: "subagent_2",
        runId: "run_2",
        sessionId: "child_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({
      contextScopeId: "subagent_2",
      runId: "run_2",
      sessionId: "child_1",
    });
    await expect(
      ledger.claimPendingRun({
        contextScopeId: "subagent_1",
        runId: "run_3",
        sessionId: "child_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(SessionRunBusyError);
  });

  it("allows only one same-session claim across two database connections", async () => {
    const firstConnection = new NodeSqliteConnection(getDatabase().path);
    const secondConnection = new NodeSqliteConnection(getDatabase().path);
    try {
      const firstLedger = createDatabaseRunLedger({
        db: firstConnection,
        now: () => 1_000,
      });
      const secondLedger = createDatabaseRunLedger({
        db: secondConnection,
        now: () => 2_000,
      });

      const results = await Promise.allSettled([
        firstLedger.claimPendingRun({
          runId: "run_first",
          sessionId: "session_1",
          triggerSource: "user",
        }),
        secondLedger.claimPendingRun({
          runId: "run_second",
          sessionId: "session_1",
          triggerSource: "user",
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(rejected?.reason).toBeInstanceOf(SessionRunBusyError);
    } finally {
      firstConnection.close();
      secondConnection.close();
    }
  });

  it("allows a later claim after the session's active run reaches a terminal state", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    await ledger.claimPendingRun({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("run_1");
    await ledger.markCancelled("run_1", "interrupted by test");

    await expect(
      ledger.claimPendingRun({
        runId: "run_2",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({
      runId: "run_2",
      sessionId: "session_1",
      status: "pending",
    });
  });

  it("recovers dead-owner active runs without interrupting live owners", async () => {
    const livePids = new Set([111]);
    const ledger = createDatabaseRunLedger({
      isOwnerAlive: (pid) => livePids.has(pid),
      now: createClock(),
      ownerId: "owner_live",
      ownerPid: 111,
    });
    const staleLedger = createDatabaseRunLedger({
      isOwnerAlive: (pid) => livePids.has(pid),
      now: createClock(10_000),
      ownerId: "owner_dead",
      ownerPid: 222,
    });

    await ledger.claimPendingRun({
      runId: "run_live",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("run_live");
    await staleLedger.claimPendingRun({
      runId: "run_dead",
      sessionId: "session_2",
      triggerSource: "user",
    });
    await staleLedger.markRunning("run_dead");

    await expect(ledger.recoverOrphanedRuns()).resolves.toEqual({
      updatedCount: 1,
    });
    await expect(ledger.get("run_live")).resolves.toMatchObject({
      ownerId: "owner_live",
      ownerPid: 111,
      status: "running",
    });
    await expect(ledger.get("run_dead")).resolves.toMatchObject({
      error: "process interrupted before owner exited",
      ownerId: "owner_dead",
      ownerPid: 222,
      status: "interrupted",
    });
  });

  it("lazily recovers dead-owner runs before a same-session claim", async () => {
    const ledger = createDatabaseRunLedger({
      isOwnerAlive: () => false,
      now: createClock(),
      ownerId: "owner_live",
      ownerPid: 111,
    });

    await ledger.createPending({
      ownerId: "owner_dead",
      ownerPid: 222,
      runId: "run_stale",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("run_stale");

    await expect(
      ledger.claimPendingRun({
        runId: "run_after_stale",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({
      ownerId: "owner_live",
      ownerPid: 111,
      runId: "run_after_stale",
      status: "pending",
    });
    await expect(ledger.get("run_stale")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  it("does not overwrite terminal status when a transition races", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    await ledger.createPending({
      runId: "run_1",
      sessionId: "session_1",
      triggerSource: "user",
    });

    const racingLedger = createDatabaseRunLedger({
      db: createStatusRaceConnection("run_1", "succeeded"),
      now: createClock(),
    });

    await expect(racingLedger.markRunning("run_1")).rejects.toBeInstanceOf(
      InvalidRunTransitionError,
    );
    await expect(ledger.get("run_1")).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("marks active records interrupted and lists active/session history", async () => {
    const ledger = createDatabaseRunLedger({ now: createClock() });
    await ledger.createPending({
      runId: "old_done",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.markRunning("old_done");
    await ledger.markSucceeded("old_done");
    await ledger.createPending({
      runId: "active_pending",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.createPending({
      runId: "other_session",
      sessionId: "session_2",
      triggerSource: "user",
    });
    await ledger.markRunning("other_session");

    await expect(
      ledger.markInterrupted({ recoverUnknownOwner: true }),
    ).resolves.toEqual({
      updatedCount: 2,
    });
    await expect(ledger.getActiveRuns()).resolves.toEqual([]);
    await expect(
      ledger.listBySession("session_1", { limit: 2 }),
    ).resolves.toMatchObject([
      { runId: "active_pending" },
      { runId: "old_done" },
    ]);
    await expect(ledger.get("active_pending")).resolves.toMatchObject({
      status: "interrupted",
      error: "process interrupted before run completed",
    });
  });
});

function createClock(startAt = 1_000): () => number {
  let current = startAt;
  return () => {
    const value = current;
    current += 1_000;
    return value;
  };
}

function createStatusRaceConnection(
  runId: string,
  status: string,
): DatabaseConnection {
  const db = getDatabase();
  let armed = true;
  return {
    path: db.path,
    exec(sql): void {
      if (armed && sql === "BEGIN IMMEDIATE") {
        armed = false;
        const other = new NodeSqliteConnection(db.path);
        try {
          other
            .prepare(
              `UPDATE ${schema.runLedger.tableName} SET status = ?, ended_at = ? WHERE run_id = ?`,
            )
            .run(status, 9_999, runId);
        } finally {
          other.close();
        }
      }
      db.exec(sql);
    },
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),
    close(): void {
      throw new Error("Test wrapper must not close shared database");
    },
  };
}

it("records a single interruption with the original end time and preserves committed terminals", async () => {
  const ledger = createDatabaseRunLedger({
    now: () => 100,
    isOwnerAlive: () => true,
  });
  await ledger.createPending({
    runId: "interrupt_one",
    sessionId: "session_1",
    triggerSource: "user",
  });
  await expect(
    ledger.markRunInterrupted("interrupt_one", "user stop", { endedAt: 42 }),
  ).resolves.toMatchObject({
    status: "interrupted",
    endedAt: 42,
    inputsCloseReason: "user stop",
  });
  await expect(
    ledger.markRunInterrupted("interrupt_one", "late", { endedAt: 90 }),
  ).resolves.toMatchObject({
    status: "interrupted",
    endedAt: 42,
    error: "user stop",
  });
  await ledger.createPending({
    runId: "success_one",
    sessionId: "session_2",
    triggerSource: "user",
  });
  await ledger.markRunning("success_one");
  await ledger.markSucceeded("success_one", { endedAt: 66 });
  await expect(
    ledger.markRunInterrupted("success_one", "late stop"),
  ).resolves.toMatchObject({ status: "succeeded", endedAt: 66 });
});

it("bulk interruption does not touch another live owner", async () => {
  const ledger = createDatabaseRunLedger({
    isOwnerAlive: (pid) => pid === 123,
  });
  await ledger.createPending({
    runId: "live_owner",
    sessionId: "session_1",
    triggerSource: "user",
    ownerId: "live",
    ownerPid: 123,
  });
  await ledger.createPending({
    runId: "dead_owner",
    sessionId: "session_2",
    triggerSource: "user",
    ownerId: "dead",
    ownerPid: 456,
  });
  await expect(ledger.markInterrupted()).resolves.toEqual({ updatedCount: 1 });
  expect((await ledger.get("live_owner"))?.status).toBe("pending");
  expect(await ledger.get("dead_owner")).toMatchObject({
    status: "interrupted",
    endTimeSource: "recovery",
  });
});

it("labels orphaned end times as recovery without rewriting a saved terminal", async () => {
  const ledger = createDatabaseRunLedger({
    now: () => 500,
    isOwnerAlive: () => false,
  });
  await ledger.createPending({
    runId: "orphan_time",
    sessionId: "session_1",
    triggerSource: "user",
    ownerPid: 456,
  });
  await ledger.createPending({
    runId: "finished_time",
    sessionId: "session_2",
    triggerSource: "user",
    ownerPid: 456,
  });
  await ledger.markRunInterrupted("finished_time", "service-shutdown", {
    endedAt: 200,
  });
  await expect(ledger.recoverOrphanedRuns()).resolves.toEqual({
    updatedCount: 1,
  });
  expect(await ledger.get("orphan_time")).toMatchObject({
    status: "interrupted",
    endTimeSource: "recovery",
    endedAt: 500,
  });
  expect(await ledger.get("finished_time")).toMatchObject({
    status: "interrupted",
    endedAt: 200,
  });
  expect((await ledger.get("finished_time"))?.endTimeSource).toBeUndefined();
});

it("scopes cold recovery and requires explicit offline permission for unknown owners", async () => {
  const ledger = createDatabaseRunLedger({ isOwnerAlive: () => false });
  await ledger.createPending({
    runId: "unknown_owner",
    sessionId: "session_1",
    triggerSource: "user",
  });
  await ledger.createPending({
    runId: "other_orphan",
    sessionId: "session_2",
    triggerSource: "user",
    ownerPid: 456,
  });
  await expect(
    ledger.recoverOrphanedRuns({ sessionId: "session_1" }),
  ).resolves.toEqual({ updatedCount: 0 });
  await expect(
    ledger.markInterrupted({ sessionId: "session_1" }),
  ).resolves.toEqual({ updatedCount: 0 });
  expect((await ledger.get("other_orphan"))?.status).toBe("pending");
  await expect(
    ledger.recoverOrphanedRuns({
      sessionId: "session_1",
      recoverUnknownOwner: true,
    }),
  ).resolves.toEqual({ updatedCount: 1 });
  expect((await ledger.get("other_orphan"))?.status).toBe("pending");
  await expect(
    ledger.markInterrupted({ sessionId: "session_2" }),
  ).resolves.toEqual({ updatedCount: 1 });
});
