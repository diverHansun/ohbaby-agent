import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import type {
  DatabaseConnection,
  DatabaseStatement,
  StatementRunResult,
  SqliteValue,
} from "./types.js";

const require = createRequire(import.meta.url);

function loadNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

class NodeSqliteStatement<Row> implements DatabaseStatement<Row> {
  constructor(private readonly statement: StatementSync) {}

  get(...params: SqliteValue[]): Row | undefined {
    return this.statement.get(...params) as Row | undefined;
  }

  all(...params: SqliteValue[]): Row[] {
    return this.statement.all(...params) as Row[];
  }

  run(...params: SqliteValue[]): StatementRunResult {
    const result = this.statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

export class NodeSqliteConnection implements DatabaseConnection {
  private readonly database: DatabaseSyncType;

  constructor(readonly path: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.database = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare<Row = Record<string, unknown>>(sql: string): DatabaseStatement<Row> {
    return new NodeSqliteStatement<Row>(this.database.prepare(sql));
  }

  pragma<Row = Record<string, unknown>>(name: string): Row[] {
    if (!/^[a-z_]+$/i.test(name)) {
      throw new Error(`Invalid pragma name: ${name}`);
    }
    const rows = this.prepare(`PRAGMA ${name}`).all();
    if (name === "busy_timeout") {
      return rows.map((row) => ({
        ...row,
        busy_timeout: row.timeout,
      })) as Row[];
    }
    return rows as Row[];
  }

  close(): void {
    this.database.close();
  }
}
