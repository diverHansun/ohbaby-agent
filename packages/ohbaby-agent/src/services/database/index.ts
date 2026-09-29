import { randomUUID } from "node:crypto";
import { NodeSqliteConnection } from "./connection.js";
import { DatabaseNotInitializedError, MigrationError } from "./errors.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";
import { ensureDatabaseDirectory, resolveDatabasePath } from "./path.js";
import { isSqliteBusy } from "./busy-retry.js";
import { DatabaseBusyError } from "./errors.js";
import {
  activateDatabaseWriteBudget,
  remainingDatabaseWriteBudget,
} from "./write-budget.js";
import type {
  DatabaseConnection,
  DatabaseStatement,
  InitDatabaseOptions,
  MigrationDefinition,
  SqliteValue,
  StatementRunResult,
  SyncTransactionCallback,
} from "./types.js";

export { runWithBusyRetry } from "./busy-retry.js";
export {
  createDatabaseWriteBudget,
  getDatabaseWriteBudget,
  withDatabaseWriteBudget,
  DatabaseWriteBudgetError,
  type DatabaseWriteBudget,
} from "./write-budget.js";
export {
  DatabaseBusyError,
  DatabaseNotInitializedError,
  MigrationError,
} from "./errors.js";
export { schema } from "./schema.js";
export type {
  BusyRetryOptions,
  DatabaseConnection,
  DatabaseStatement,
  InitDatabaseOptions,
  MigrationDefinition,
  SqliteValue,
  StatementRunResult,
  SyncTransactionCallback,
} from "./types.js";

let currentConnection: DatabaseConnection | undefined;
let currentPath: string | undefined;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function isAsyncFunction(operation: unknown): boolean {
  return (
    typeof operation === "function" &&
    operation.constructor.name === "AsyncFunction"
  );
}

function createScopedTransactionConnection(connection: DatabaseConnection): {
  readonly db: DatabaseConnection;
  deactivate(): void;
} {
  let active = true;

  function assertActive(): void {
    if (!active) {
      throw new Error("Database transaction is no longer active");
    }
  }

  const db: DatabaseConnection = {
    path: connection.path,
    exec(sql: string): void {
      assertActive();
      connection.exec(sql);
    },
    prepare<Row = Record<string, unknown>>(
      sql: string,
    ): DatabaseStatement<Row> {
      assertActive();
      const statement = connection.prepare<Row>(sql);
      return {
        get(...params: SqliteValue[]): Row | undefined {
          assertActive();
          return statement.get(...params);
        },
        all(...params: SqliteValue[]): Row[] {
          assertActive();
          return statement.all(...params);
        },
        run(...params: SqliteValue[]): StatementRunResult {
          assertActive();
          return statement.run(...params);
        },
      };
    },
    pragma<Row = Record<string, unknown>>(name: string): Row[] {
      assertActive();
      return connection.pragma<Row>(name);
    },
    close(): void {
      throw new Error("Cannot close database from inside a transaction");
    },
  };

  return {
    db,
    deactivate(): void {
      active = false;
    },
  };
}

function initializePragma(connection: DatabaseConnection): void {
  // Configure the startup budget before initialization writes. SQLite journal
  // conversion can still reject immediately; failed initialization closes below.
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA foreign_keys = ON");
}

function ensureMigrationTable(connection: DatabaseConnection): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS migration (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function hasMigration(
  connection: DatabaseConnection,
  migration: MigrationDefinition,
): boolean {
  const row = connection
    .prepare<{
      version: string;
    }>("SELECT version FROM migration WHERE version = ?")
    .get(migration.version);
  return row !== undefined;
}

function applyMigration(
  connection: DatabaseConnection,
  migration: MigrationDefinition,
  appliedAt: number,
): void {
  connection.exec("BEGIN");
  try {
    connection.exec(migration.sql);
    connection
      .prepare("INSERT INTO migration (version, applied_at) VALUES (?, ?)")
      .run(migration.version, appliedAt);
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // Keep the original migration failure as the user-facing error.
    }
    throw new MigrationError(migration.version, error);
  }
}

export class DatabaseUpgradeBlockedError extends Error {
  readonly code = "DATABASE_UPGRADE_REQUIRES_OFFLINE";
  constructor(readonly ownerPid: number) {
    super(
      `Database upgrade requires offline maintenance: known writer PID ${String(ownerPid)} is alive or cannot be verified. Stop old TUI, serve and SDK hosts before retrying.`,
    );
    this.name = "DatabaseUpgradeBlockedError";
  }
}

function prepareOfflineMigration(
  connection: DatabaseConnection,
  migrations: readonly MigrationDefinition[],
  options: InitDatabaseOptions,
): void {
  if (
    !migrations.some(
      (migration) =>
        migration.requiresOfflineBackup && !hasMigration(connection, migration),
    )
  )
    return;
  const existing =
    connection
      .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM migration")
      .get()?.count ?? 0;
  if (existing === 0) return; // New installations have no legacy work or data to retain.
  const pids = new Set(options.knownWriterPids ?? []);
  for (const table of [
    "run_ledger",
    "subagent_instance",
    "prompt_submission",
  ]) {
    const columns = connection
      .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
      .all();
    if (!columns.some((column) => column.name === "owner_pid")) continue;
    for (const row of connection
      .prepare<{
        owner_pid: number;
      }>(
        `SELECT DISTINCT owner_pid FROM ${table} WHERE owner_pid IS NOT NULL AND status IN ('pending','queued','starting','running')`,
      )
      .all())
      pids.add(row.owner_pid);
  }
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw new DatabaseUpgradeBlockedError(pid);
    }
    throw new DatabaseUpgradeBlockedError(pid);
  }
  const backupPath =
    options.migrationBackupPath ??
    `${connection.path}.before-retained-${randomUUID()}.backup`;
  connection.prepare("VACUUM main INTO ?").run(backupPath);
  options.onMigrationBackup?.(backupPath);
}

function runMigrations(
  connection: DatabaseConnection,
  migrations: readonly MigrationDefinition[],
  now: () => number,
  options: InitDatabaseOptions,
): void {
  ensureMigrationTable(connection);
  prepareOfflineMigration(connection, migrations, options);
  for (const migration of migrations) {
    if (hasMigration(connection, migration)) {
      continue;
    }
    applyMigration(connection, migration, now());
  }
}

export function initDatabase(options: InitDatabaseOptions = {}): void {
  const dbPath = resolveDatabasePath(options.dbPath);
  const migrations = options.migrations ?? INITIAL_MIGRATIONS;
  const now = options.now ?? Date.now;

  if (currentConnection) {
    if (currentPath === dbPath) {
      currentConnection.exec("PRAGMA busy_timeout = 5000");
      try {
        runMigrations(currentConnection, migrations, now, options);
      } finally {
        currentConnection.exec("PRAGMA busy_timeout = 25");
      }
      return;
    }
    closeDatabase();
  }

  ensureDatabaseDirectory(dbPath);
  const connection = new NodeSqliteConnection(dbPath);
  try {
    initializePragma(connection);
    runMigrations(connection, migrations, now, options);
    connection.exec("PRAGMA busy_timeout = 25");
  } catch (error) {
    connection.close();
    throw error;
  }

  currentConnection = connection;
  currentPath = dbPath;
}

export function getDatabase(): DatabaseConnection {
  if (!currentConnection) {
    throw new DatabaseNotInitializedError();
  }
  return currentConnection;
}

export function closeDatabase(): void {
  if (!currentConnection) {
    return;
  }
  beginDatabaseShutdown(Date.now(), currentConnection);
  currentConnection.close();
  currentConnection = undefined;
  currentPath = undefined;
}

// One FIFO per connection: reserve before waiting, never hold a transaction over await.
const writeTails = new WeakMap<DatabaseConnection, Promise<void>>();
const WRITE_WAIT_BUDGET_MS = 5000;
const shutdownDeadlines = new WeakMap<DatabaseConnection, number>();

/** Tighten every current and future write on a connection; never extend it. */
export function beginDatabaseShutdown(
  deadlineAt: number,
  connection: DatabaseConnection = getDatabase(),
): void {
  shutdownDeadlines.set(
    connection,
    Math.min(shutdownDeadlines.get(connection) ?? Infinity, deadlineAt),
  );
}

export class DatabaseShutdownError extends Error {
  constructor() {
    super("Database shutdown deadline reached; write permission revoked");
    this.name = "DatabaseShutdownError";
  }
}

export async function runWriteTransaction<T>(
  connection: DatabaseConnection,
  operation: (db: DatabaseConnection) => T,
): Promise<T> {
  if (isAsyncFunction(operation)) {
    throw new Error("Database transactions require a synchronous callback");
  }
  const stopBudgetClock = activateDatabaseWriteBudget();
  const deadline = performance.now() + WRITE_WAIT_BUDGET_MS;
  const remainingBudget = (): number => {
    const shutdownRemaining =
      (shutdownDeadlines.get(connection) ?? Infinity) - Date.now();
    if (shutdownRemaining <= 0) throw new DatabaseShutdownError();
    const remaining = Math.min(
      deadline - performance.now(),
      shutdownRemaining,
      remainingDatabaseWriteBudget(),
    );
    if (remaining <= 0) throw new DatabaseBusyError(0, undefined);
    return remaining;
  };
  const previous = writeTails.get(connection) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeTails.set(connection, turn);
  let acquired = false;
  const finishTurn = (): void => {
    release();
    if (writeTails.get(connection) === turn) writeTails.delete(connection);
  };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // An expired queued write fails promptly, retaining its place in the FIFO
      // until its predecessor exits so the following writer cannot overtake it.
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              remainingBudget();
              reject(new DatabaseBusyError(0, undefined));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }, Math.ceil(remainingBudget()));
        }),
      ]);
      acquired = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Yield even between uncontended writes so a long FIFO cannot starve Stop.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let attempts = 0;
    let lastBusy: unknown;
    for (;;) {
      const remaining = remainingBudget();
      if (remaining <= 0) {
        throw new DatabaseBusyError(attempts, lastBusy);
      }
      // The synchronous SQLite wait consumes the same remaining shutdown budget.
      connection.exec(
        `PRAGMA busy_timeout = ${String(Math.max(0, Math.min(25, Math.floor(remaining))))}`,
      );
      attempts += 1;
      try {
        connection.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        lastBusy = error;
        const remaining = remainingBudget();
        if (remaining <= 0) throw new DatabaseBusyError(attempts, error);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(25, remaining)),
        );
      }
    }
    const scoped = createScopedTransactionConnection(connection);
    try {
      remainingBudget();
      const result = operation(scoped.db);
      if (isThenable(result)) {
        // Observe a rejected accidental async callback as well as rejecting this write.
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Database transactions require a synchronous callback");
      }
      const commitBudget = remainingBudget();
      connection.exec(
        `PRAGMA busy_timeout = ${String(Math.max(0, Math.min(25, Math.floor(commitBudget))))}`,
      );
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      scoped.deactivate();
    }
  } finally {
    stopBudgetClock();
    if (acquired) finishTurn();
    else void previous.then(finishTurn);
  }
}

export function withTransaction<T>(
  operation: SyncTransactionCallback<T>,
): Promise<T> {
  return runWriteTransaction(getDatabase(), operation);
}
