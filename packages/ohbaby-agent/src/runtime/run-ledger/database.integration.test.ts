import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
  type DatabaseConnection,
  type DatabaseStatement,
  type SqliteValue,
  type StatementRunResult,
} from "../../services/database/index.js";
import { NodeSqliteConnection } from "../../services/database/connection.js";
import {
  createDatabaseRunLedger,
  InvalidRunTransitionError,
  RunLedgerNotFoundError,
  SessionRunBusyError,
} from "./index.js";

const cleanupPaths: string[] = [];

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

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
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

    await expect(ledger.markInterrupted()).resolves.toEqual({
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
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare<Row = Record<string, unknown>>(
      sql: string,
    ): DatabaseStatement<Row> {
      const statement = db.prepare<Row>(sql);
      if (
        !sql.includes(`FROM ${schema.runLedger.tableName} WHERE run_id = ?`)
      ) {
        return statement;
      }
      return {
        get(...params: SqliteValue[]): Row | undefined {
          const row = statement.get(...params);
          if (armed && row !== undefined && params[0] === runId) {
            armed = false;
            db.prepare(
              `UPDATE ${schema.runLedger.tableName}
               SET status = ?, ended_at = ?
               WHERE run_id = ?`,
            ).run(status, 9_999, runId);
          }
          return row;
        },
        all(...params: SqliteValue[]): Row[] {
          return statement.all(...params);
        },
        run(...params: SqliteValue[]): StatementRunResult {
          return statement.run(...params);
        },
      };
    },
    pragma<Row = Record<string, unknown>>(name: string): Row[] {
      return db.pragma<Row>(name);
    },
    close(): void {
      throw new Error("Test connection wrapper must not close the database");
    },
  };
}
