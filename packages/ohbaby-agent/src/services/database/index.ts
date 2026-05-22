import { NodeSqliteConnection } from "./connection.js";
import { DatabaseNotInitializedError, MigrationError } from "./errors.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";
import { ensureDatabaseDirectory, resolveDatabasePath } from "./path.js";
import { runWithBusyRetry } from "./busy-retry.js";
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
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
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
      runMigrations(currentConnection, migrations, now);
      return;
    }
    closeDatabase();
  }

  ensureDatabaseDirectory(dbPath);
  const connection = new NodeSqliteConnection(dbPath);
  try {
    initializePragma(connection);
    runMigrations(connection, migrations, now);
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

export function withTransaction<T>(operation: SyncTransactionCallback<T>): T {
  if (isAsyncFunction(operation)) {
    throw new Error("Database transactions require a synchronous callback");
  }
  return runWithBusyRetry(() => {
    const connection = getDatabase();
    const scoped = createScopedTransactionConnection(connection);
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(scoped.db);
      if (isThenable(result)) {
        throw new Error("Database transactions require a synchronous callback");
      }
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // Keep the original operation error intact.
      }
      throw error;
    } finally {
      scoped.deactivate();
    }
  });
}
