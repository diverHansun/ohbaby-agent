import {
  getDatabase,
  runWithBusyRetry,
  schema,
  type DatabaseConnection,
} from "../../services/database/index.js";
import {
  InvalidRunTransitionError,
  RunLedgerNotFoundError,
  SessionRunBusyError,
} from "./errors.js";
import type {
  ClaimPendingRunLedgerInput,
  CreatePendingRunLedgerInput,
  InMemoryRunLedgerOptions,
  ListRunLedgerOptions,
  MarkInterruptedOptions,
  MarkInterruptedResult,
  RunLedger,
  RunLedgerRecord,
  RunStatus,
  TriggerSource,
} from "./types.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["pending", "running"]);
const INTERRUPTABLE_STATUSES = new Set<RunStatus>(["pending", "running"]);
const INTERRUPTED_REASON = "process interrupted before run completed";
const ORPHANED_OWNER_REASON = "process interrupted before owner exited";

interface RunLedgerRow {
  readonly run_id: string;
  readonly session_id: string;
  readonly trigger: TriggerSource;
  readonly status: RunStatus;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly error: string | null;
  readonly owner_id: string | null;
  readonly owner_pid: number | null;
}

interface DatabaseRunLedgerOptions extends InMemoryRunLedgerOptions {
  readonly db?: DatabaseConnection;
}

function rowToRecord(row: RunLedgerRow): RunLedgerRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    triggerSource: row.trigger,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    error: row.error ?? undefined,
    ownerId: row.owner_id ?? undefined,
    ownerPid: row.owner_pid ?? undefined,
  };
}

function cloneRecord(record: RunLedgerRecord): RunLedgerRecord {
  return { ...record };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function normalizeLimit(options?: ListRunLedgerOptions): number | undefined {
  if (options?.limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new RangeError(
      "Run ledger list limit must be a non-negative integer",
    );
  }
  return options.limit;
}

function validateInterruptibleStatuses(statuses: Iterable<RunStatus>): void {
  for (const status of statuses) {
    if (!INTERRUPTABLE_STATUSES.has(status)) {
      throw new InvalidRunTransitionError("bulk", status, "interrupted");
    }
  }
}

function defaultIsOwnerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code !== "ESRCH";
  }
}

export function createDatabaseRunLedger(
  options: DatabaseRunLedgerOptions = {},
): RunLedger {
  const db = options.db ?? getDatabase();
  const isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
  const now = options.now ?? Date.now;

  async function withAsyncBoundary<T>(operation: () => T): Promise<T> {
    await Promise.resolve();
    return operation();
  }

  function getRow(runId: string): RunLedgerRow | undefined {
    return db
      .prepare<RunLedgerRow>(
        `SELECT * FROM ${schema.runLedger.tableName} WHERE run_id = ?`,
      )
      .get(runId);
  }

  function getRowInConnection(
    connection: DatabaseConnection,
    runId: string,
  ): RunLedgerRow | undefined {
    return connection
      .prepare<RunLedgerRow>(
        `SELECT * FROM ${schema.runLedger.tableName} WHERE run_id = ?`,
      )
      .get(runId);
  }

  function insertPendingRow(
    connection: DatabaseConnection,
    input: CreatePendingRunLedgerInput,
  ): RunLedgerRecord {
    if (getRowInConnection(connection, input.runId)) {
      throw new InvalidRunTransitionError(input.runId, undefined, "pending");
    }
    const ownerId = input.ownerId ?? options.ownerId;
    const ownerPid = input.ownerPid ?? options.ownerPid;
    const record: RunLedgerRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      triggerSource: input.triggerSource,
      status: "pending",
      createdAt: now(),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(ownerPid === undefined ? {} : { ownerPid }),
    };
    connection
      .prepare(
        `INSERT INTO ${schema.runLedger.tableName}
          (run_id, session_id, trigger, status, created_at, owner_id, owner_pid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.sessionId,
        record.triggerSource,
        record.status,
        record.createdAt,
        record.ownerId ?? null,
        record.ownerPid ?? null,
      );
    return record;
  }

  function getActiveRowsForSession(
    connection: DatabaseConnection,
    sessionId: string,
  ): RunLedgerRow[] {
    const statuses = Array.from(ACTIVE_STATUSES);
    const placeholders = statuses.map(() => "?").join(", ");
    return connection
      .prepare<RunLedgerRow>(
        `SELECT * FROM ${schema.runLedger.tableName}
         WHERE session_id = ? AND status IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(sessionId, ...statuses);
  }

  function getActiveRows(connection: DatabaseConnection): RunLedgerRow[] {
    const statuses = Array.from(ACTIVE_STATUSES);
    const placeholders = statuses.map(() => "?").join(", ");
    return connection
      .prepare<RunLedgerRow>(
        `SELECT * FROM ${schema.runLedger.tableName}
         WHERE status IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...statuses);
  }

  function isOrphaned(
    row: RunLedgerRow,
    recoverUnknownOwner: boolean,
  ): boolean {
    if (!ACTIVE_STATUSES.has(row.status)) {
      return false;
    }
    if (row.owner_pid === null) {
      return recoverUnknownOwner;
    }
    return !isOwnerAlive(row.owner_pid);
  }

  function recoverOrphanedRows(
    connection: DatabaseConnection,
    rows: readonly RunLedgerRow[],
    recoverUnknownOwner: boolean,
  ): number {
    let updatedCount = 0;
    for (const row of rows) {
      if (!isOrphaned(row, recoverUnknownOwner)) {
        continue;
      }
      const result = connection
        .prepare(
          `UPDATE ${schema.runLedger.tableName}
           SET status = ?, ended_at = ?, error = ?
           WHERE run_id = ? AND status IN ('pending', 'running')`,
        )
        .run("interrupted", now(), ORPHANED_OWNER_REASON, row.run_id);
      updatedCount += result.changes;
    }
    return updatedCount;
  }

  function withImmediateTransaction<T>(operation: () => T): T {
    return runWithBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original ledger error.
        }
        throw error;
      }
    });
  }

  function transition(
    runId: string,
    toStatus: RunStatus,
    allowedFrom: readonly RunStatus[],
    update: (record: RunLedgerRecord) => RunLedgerRecord,
  ): RunLedgerRecord {
    const row = getRow(runId);
    if (!row) {
      throw new RunLedgerNotFoundError(runId);
    }
    const current = rowToRecord(row);
    if (!allowedFrom.includes(current.status)) {
      throw new InvalidRunTransitionError(runId, current.status, toStatus);
    }
    const next = update(current);
    const allowedPlaceholders = allowedFrom.map(() => "?").join(", ");
    const result = db
      .prepare(
        `UPDATE ${schema.runLedger.tableName}
       SET status = ?, started_at = ?, ended_at = ?, error = ?
       WHERE run_id = ? AND status IN (${allowedPlaceholders})`,
      )
      .run(
        next.status,
        next.startedAt ?? null,
        next.endedAt ?? null,
        next.error ?? null,
        runId,
        ...allowedFrom,
      );
    if (result.changes === 0) {
      const latest = getRow(runId);
      if (!latest) {
        throw new RunLedgerNotFoundError(runId);
      }
      throw new InvalidRunTransitionError(runId, latest.status, toStatus);
    }
    return next;
  }

  return {
    createPending(
      input: CreatePendingRunLedgerInput,
    ): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() => {
        return cloneRecord(insertPendingRow(db, input));
      });
    },

    claimPendingRun(
      input: ClaimPendingRunLedgerInput,
    ): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() => {
        const record = withImmediateTransaction(() => {
          const activeRows = getActiveRowsForSession(db, input.sessionId);
          recoverOrphanedRows(db, activeRows, false);
          const activeRunIds = activeRows
            .filter((row) => !isOrphaned(row, false))
            .map((row) => row.run_id);
          if (activeRunIds.length > 0) {
            throw new SessionRunBusyError(input.sessionId, activeRunIds);
          }
          return insertPendingRow(db, input);
        });
        return cloneRecord(record);
      });
    },

    markRunning(runId: string): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() =>
        cloneRecord(
          transition(runId, "running", ["pending"], (record) => ({
            ...record,
            status: "running",
            startedAt: now(),
            endedAt: undefined,
            error: undefined,
          })),
        ),
      );
    },

    markSucceeded(runId: string): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() =>
        cloneRecord(
          transition(runId, "succeeded", ["running"], (record) => ({
            ...record,
            status: "succeeded",
            endedAt: now(),
            error: undefined,
          })),
        ),
      );
    },

    markFailed(runId: string, error: unknown): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() =>
        cloneRecord(
          transition(runId, "failed", ["pending", "running"], (record) => ({
            ...record,
            status: "failed",
            endedAt: now(),
            error: errorToMessage(error),
          })),
        ),
      );
    },

    markCancelled(runId: string, reason?: string): Promise<RunLedgerRecord> {
      return withAsyncBoundary(() =>
        cloneRecord(
          transition(runId, "cancelled", ["pending", "running"], (record) => ({
            ...record,
            status: "cancelled",
            endedAt: now(),
            error: reason,
          })),
        ),
      );
    },

    markInterrupted(
      options: MarkInterruptedOptions = {},
    ): Promise<MarkInterruptedResult> {
      return withAsyncBoundary(() => {
        const statuses = Array.from(
          new Set(options.statuses ?? INTERRUPTABLE_STATUSES),
        );
        validateInterruptibleStatuses(statuses);
        if (statuses.length === 0) {
          return { updatedCount: 0 };
        }
        const endedAt = now();
        const placeholders = statuses.map(() => "?").join(", ");
        const result = db
          .prepare(
            `UPDATE ${schema.runLedger.tableName}
             SET status = ?, ended_at = ?, error = ?
             WHERE status IN (${placeholders})`,
          )
          .run(
            "interrupted",
            endedAt,
            options.reason ?? INTERRUPTED_REASON,
            ...statuses,
          );
        return { updatedCount: result.changes };
      });
    },

    recoverOrphanedRuns(): Promise<MarkInterruptedResult> {
      return withAsyncBoundary(() => {
        const updatedCount = withImmediateTransaction(() =>
          recoverOrphanedRows(db, getActiveRows(db), true),
        );
        return { updatedCount };
      });
    },

    get(runId: string): Promise<RunLedgerRecord | undefined> {
      return withAsyncBoundary(() => {
        const row = getRow(runId);
        return row ? cloneRecord(rowToRecord(row)) : undefined;
      });
    },

    listBySession(
      sessionId: string,
      options?: ListRunLedgerOptions,
    ): Promise<RunLedgerRecord[]> {
      return withAsyncBoundary(() => {
        const limit = normalizeLimit(options);
        const sql = `SELECT * FROM ${schema.runLedger.tableName}
           WHERE session_id = ?
           ORDER BY created_at DESC${limit === undefined ? "" : " LIMIT ?"}`;
        const params = limit === undefined ? [sessionId] : [sessionId, limit];
        return db
          .prepare<RunLedgerRow>(sql)
          .all(...params)
          .map(rowToRecord)
          .map(cloneRecord);
      });
    },

    getActiveRuns(sessionId?: string): Promise<RunLedgerRecord[]> {
      return withAsyncBoundary(() => {
        const statuses = Array.from(ACTIVE_STATUSES);
        const statusPlaceholders = statuses.map(() => "?").join(", ");
        const rows =
          sessionId === undefined
            ? db
                .prepare<RunLedgerRow>(
                  `SELECT * FROM ${schema.runLedger.tableName}
                   WHERE status IN (${statusPlaceholders})
                   ORDER BY created_at ASC`,
                )
                .all(...statuses)
            : db
                .prepare<RunLedgerRow>(
                  `SELECT * FROM ${schema.runLedger.tableName}
                   WHERE status IN (${statusPlaceholders}) AND session_id = ?
                   ORDER BY created_at ASC`,
                )
                .all(...statuses, sessionId);
        return rows.map(rowToRecord).map(cloneRecord);
      });
    },
  };
}
