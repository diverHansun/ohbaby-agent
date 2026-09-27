import { NodeSqliteConnection } from "./connection.js";
import { DatabaseNotInitializedError, MigrationError } from "./errors.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";
import { ensureDatabaseDirectory, resolveDatabasePath } from "./path.js";
import { isSqliteBusy } from "./busy-retry.js";
import { DatabaseBusyError } from "./errors.js";
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

function runMigrations(
  connection: DatabaseConnection,
  migrations: readonly MigrationDefinition[],
  now: () => number,
): void {
  ensureMigrationTable(connection);
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
        runMigrations(currentConnection, migrations, now);
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
    runMigrations(connection, migrations, now);
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
  currentConnection.close();
  currentConnection = undefined;
  currentPath = undefined;
}

// One FIFO per connection: reserve before waiting, never hold a transaction over await.
const writeTails = new WeakMap<DatabaseConnection, Promise<void>>();
const WRITE_WAIT_BUDGET_MS = 5000;

export async function runWriteTransaction<T>(
  connection: DatabaseConnection,
  operation: (db: DatabaseConnection) => T,
): Promise<T> {
  if (isAsyncFunction(operation)) {
    throw new Error("Database transactions require a synchronous callback");
  }
  const deadline = performance.now() + WRITE_WAIT_BUDGET_MS;
  const previous = writeTails.get(connection) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeTails.set(connection, turn);
  await previous;
  try {
    // Yield even between uncontended writes so a long FIFO cannot starve Stop.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    connection.exec("PRAGMA busy_timeout = 25");
    let attempts = 0;
    let lastBusy: unknown;
    for (;;) {
      if (performance.now() >= deadline) {
        throw new DatabaseBusyError(attempts, lastBusy);
      }
      attempts += 1;
      try {
        connection.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        lastBusy = error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new DatabaseBusyError(attempts, error);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(25, remaining)),
        );
      }
    }
    const scoped = createScopedTransactionConnection(connection);
    try {
      const result = operation(scoped.db);
      if (isThenable(result)) {
        // Observe a rejected accidental async callback as well as rejecting this write.
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Database transactions require a synchronous callback");
      }
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
    release();
    if (writeTails.get(connection) === turn) writeTails.delete(connection);
  }
}

export function withTransaction<T>(
  operation: SyncTransactionCallback<T>,
): Promise<T> {
  return runWriteTransaction(getDatabase(), operation);
}
