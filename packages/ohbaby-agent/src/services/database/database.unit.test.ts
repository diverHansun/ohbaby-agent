import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  type DatabaseConnection,
  DatabaseBusyError,
  DatabaseNotInitializedError,
  getDatabase,
  initDatabase,
  MigrationError,
  runWithBusyRetry,
  schema,
  withTransaction,
  type MigrationDefinition,
  type SyncTransactionCallback,
} from "./index.js";

const cleanupPaths: string[] = [];

async function tempDbPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-db-"));
  cleanupPaths.push(directory);
  return join(directory, "agent.db");
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("services/database", () => {
  it("throws a clear error when getDatabase is used before initialization", () => {
    expect(() => getDatabase()).toThrow(DatabaseNotInitializedError);
  });

  it("initializes a file database with pragma settings and the initial schema", async () => {
    const dbPath = await tempDbPath();

    initDatabase({ dbPath });

    const db = getDatabase();
    expect(db.pragma<{ journal_mode: string }>("journal_mode")[0]?.journal_mode)
      .toBe("wal");
    expect(db.pragma<{ foreign_keys: number }>("foreign_keys")[0]?.foreign_keys)
      .toBe(1);
    expect(db.pragma<{ busy_timeout: number }>("busy_timeout")[0]?.busy_timeout)
      .toBe(5000);
    expect(
      db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(schema.session.tableName),
    ).toEqual({ name: "session" });
  });

  it("records migrations only once across repeated initialization", async () => {
    const dbPath = await tempDbPath();

    initDatabase({ dbPath });
    initDatabase({ dbPath });

    const rows = getDatabase()
      .prepare<{ version: string }>(
        `SELECT version FROM ${schema.migration.tableName} ORDER BY version`,
      )
      .all();
    expect(rows).toEqual([{ version: "001_initial" }]);
  });

  it("rolls back a failed migration and exposes the failed version", async () => {
    const dbPath = await tempDbPath();
    const migrations: MigrationDefinition[] = [
      {
        version: "001_ok",
        sql: "CREATE TABLE ok_table (id TEXT PRIMARY KEY);",
      },
      {
        version: "002_bad",
        sql: "CREATE TABLE bad_table (id TEXT PRIMARY KEY); INSERT INTO missing_table VALUES ('x');",
      },
    ];

    expect(() => {
      initDatabase({ dbPath, migrations });
    }).toThrow(MigrationError);

    closeDatabase();
    initDatabase({ dbPath, migrations: migrations.slice(0, 1) });
    const db = getDatabase();
    expect(
      db
        .prepare<{ version: string }>(
          `SELECT version FROM ${schema.migration.tableName}`,
        )
        .all(),
    ).toEqual([{ version: "001_ok" }]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bad_table'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("enforces foreign keys at the database layer", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });

    expect(() => {
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.message.tableName}
            (id, session_id, role, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("msg_1", "missing_session", "user", 1, 1, "{}");
    }).toThrow(/FOREIGN KEY/i);
  });

  it("rolls back all writes when a transaction fails", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });

    expect(() => {
      withTransaction((db) => {
        db.prepare(
          `INSERT INTO ${schema.session.tableName}
            (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "session_1",
          "project_1",
          "/tmp/project",
          "default",
          "hello",
          "active",
          1,
          1,
          0,
          "{}",
        );
        db.prepare(
          `INSERT INTO ${schema.message.tableName}
            (id, session_id, role, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("msg_1", "missing_session", "user", 1, 1, "{}");
      });
    }).toThrow(/FOREIGN KEY/i);

    expect(
      getDatabase()
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${schema.session.tableName}`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("commits all writes when a transaction succeeds", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });

    withTransaction((db) => {
      db.prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "session_1",
        "project_1",
        "/tmp/project",
        "default",
        "hello",
        "active",
        1,
        1,
        0,
        "{}",
      );
    });

    expect(
      getDatabase()
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${schema.session.tableName}`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rejects async transaction callbacks without executing delayed writes", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });

    const asyncOperation = async (db: DatabaseConnection): Promise<void> => {
      await Promise.resolve();
      db.prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "session_1",
        "project_1",
        "/tmp/project",
        "default",
        "hello",
        "active",
        1,
        1,
        0,
        "{}",
      );
    };

    expect(() => {
      withTransaction(
        asyncOperation as unknown as (db: DatabaseConnection) => void,
      );
    }).toThrow(/synchronous/);
    await Promise.resolve();

    expect(
      getDatabase()
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${schema.session.tableName}`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("invalidates the transaction connection when a thenable escapes", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });
    let escaped: Promise<void> | undefined;
    const escapingOperation = ((db: DatabaseConnection) => {
      escaped = Promise.resolve().then(() => {
        db.prepare(
          `INSERT INTO ${schema.session.tableName}
            (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "session_1",
          "project_1",
          "/tmp/project",
          "default",
          "hello",
          "active",
          1,
          1,
          0,
          "{}",
        );
      });
      return escaped;
    }) as unknown as SyncTransactionCallback<void>;

    expect(() => {
      withTransaction(escapingOperation);
    }).toThrow(/synchronous/);

    await expect(escaped).rejects.toThrow(/transaction is no longer active/);
    expect(
      getDatabase()
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${schema.session.tableName}`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back writes performed before a thenable escapes", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });
    const thenableOperation = ((db: DatabaseConnection) => {
      db.prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "session_1",
        "project_1",
        "/tmp/project",
        "default",
        "hello",
        "active",
        1,
        1,
        0,
        "{}",
      );
      return Promise.resolve();
    }) as unknown as SyncTransactionCallback<void>;

    expect(() => {
      withTransaction(thenableOperation);
    }).toThrow(/synchronous/);

    expect(
      getDatabase()
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${schema.session.tableName}`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("prevents parts from referencing a message in a different session", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });
    const db = getDatabase();
    const insertSession = db.prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run(
      "session_a",
      "project_1",
      "/tmp/project",
      "default",
      "A",
      "active",
      1,
      1,
      0,
      "{}",
    );
    insertSession.run(
      "session_b",
      "project_1",
      "/tmp/project",
      "default",
      "B",
      "active",
      1,
      1,
      0,
      "{}",
    );
    db.prepare(
      `INSERT INTO ${schema.message.tableName}
        (id, session_id, role, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("msg_a", "session_a", "user", 1, 1, "{}");

    expect(() => {
      db.prepare(
        `INSERT INTO ${schema.part.tableName}
          (id, message_id, session_id, type, order_index, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("part_1", "msg_a", "session_b", "text", 0, 1, 1, "{}");
    }).toThrow(/FOREIGN KEY/i);
  });

  it("prevents run ledger records from referencing a missing session", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });

    expect(() => {
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.runLedger.tableName}
            (run_id, session_id, trigger, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("run_1", "missing_session", "user", "pending", 1);
    }).toThrow(/FOREIGN KEY/i);
  });

  it("prevents snapshot checkpoints from referencing a run in a different session", async () => {
    const dbPath = await tempDbPath();
    initDatabase({ dbPath });
    const db = getDatabase();
    const insertSession = db.prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run(
      "session_a",
      "project_1",
      "/tmp/project",
      "default",
      "A",
      "active",
      1,
      1,
      0,
      "{}",
    );
    insertSession.run(
      "session_b",
      "project_1",
      "/tmp/project",
      "default",
      "B",
      "active",
      1,
      1,
      0,
      "{}",
    );
    db.prepare(
      `INSERT INTO ${schema.runLedger.tableName}
        (run_id, session_id, trigger, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("run_b", "session_b", "user", "pending", 1);

    expect(() => {
      db.prepare(
        `INSERT INTO ${schema.snapshotCheckpoint.tableName}
          (checkpoint_id, session_id, run_id, turn_id, workdir, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("checkpoint_1", "session_a", "run_b", "turn_1", "/tmp/project", 1);
    }).toThrow(/FOREIGN KEY/i);
  });

  it("retries SQLITE_BUSY failures and throws DatabaseBusyError after exhaustion", () => {
    let attempts = 0;
    const result = runWithBusyRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("database is locked") as Error & {
            code: string;
          };
          error.code = "SQLITE_BUSY";
          throw error;
        }
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 0, jitterMs: 0, sleep: () => undefined },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(() =>
      runWithBusyRetry(
        () => {
          const error = new Error("database is locked") as Error & {
            code: string;
          };
          error.code = "ERR_SQLITE_ERROR";
          throw error;
        },
        { maxRetries: 1, baseDelayMs: 0, jitterMs: 0, sleep: () => undefined },
      ),
    ).toThrow(DatabaseBusyError);
  });

  it("uses the OHBABY_DB_PATH environment override", async () => {
    const dbPath = await tempDbPath();
    const previous = process.env.OHBABY_DB_PATH;
    process.env.OHBABY_DB_PATH = dbPath;
    try {
      initDatabase();
      expect(getDatabase().path).toBe(dbPath);
    } finally {
      if (previous === undefined) {
        delete process.env.OHBABY_DB_PATH;
      } else {
        process.env.OHBABY_DB_PATH = previous;
      }
    }
  });
});
