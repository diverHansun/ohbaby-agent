export class DatabaseNotInitializedError extends Error {
  constructor() {
    super("Database is not initialized; call initDatabase() first");
    this.name = "DatabaseNotInitializedError";
  }
}

export class MigrationError extends Error {
  constructor(
    readonly version: string,
    readonly originalError: unknown,
  ) {
    super(`Database migration failed: ${version}`);
    this.name = "MigrationError";
  }
}

export class DatabaseBusyError extends Error {
  constructor(
    readonly attempts: number,
    readonly originalError: unknown,
  ) {
    super(`SQLite remained busy after ${String(attempts)} attempt(s)`);
    this.name = "DatabaseBusyError";
  }
}
