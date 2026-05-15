export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface StatementRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface DatabaseStatement<Row = Record<string, unknown>> {
  get(...params: SqliteValue[]): Row | undefined;
  all(...params: SqliteValue[]): Row[];
  run(...params: SqliteValue[]): StatementRunResult;
}

export interface DatabaseConnection {
  readonly path: string;
  exec(sql: string): void;
  prepare<Row = Record<string, unknown>>(sql: string): DatabaseStatement<Row>;
  pragma<Row = Record<string, unknown>>(name: string): Row[];
  close(): void;
}

export interface MigrationDefinition {
  readonly version: string;
  readonly sql: string;
}

export interface InitDatabaseOptions {
  readonly dbPath?: string;
  readonly migrations?: readonly MigrationDefinition[];
  readonly now?: () => number;
}

export interface BusyRetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly jitterMs?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => void;
}

export type SyncTransactionCallback<T> = T extends PromiseLike<unknown>
  ? never
  : (db: DatabaseConnection) => T;
