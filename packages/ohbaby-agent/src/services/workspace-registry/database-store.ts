import {
  getDatabase,
  schema,
  withTransaction,
  type DatabaseConnection,
  type SyncTransactionCallback,
} from "../database/index.js";
import type {
  WorkspaceRegistryEntry,
  WorkspaceRegistryStore,
  WorkspaceRegistryStoreOptions,
  WorkspaceVisibility,
} from "./types.js";

interface WorkspaceRegistryRow {
  readonly scope_key: string;
  readonly visibility: WorkspaceVisibility;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_opened_at: number;
}

function rowToEntry(row: WorkspaceRegistryRow): WorkspaceRegistryEntry {
  return {
    scopeKey: row.scope_key,
    visibility: row.visibility,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export function createWorkspaceRegistryStore(
  options: WorkspaceRegistryStoreOptions = {},
): WorkspaceRegistryStore {
  const database = options.db ?? getDatabase();
  const now = options.now ?? Date.now;
  const tableName = schema.workspaceRegistry.tableName;

  function listFrom(db: DatabaseConnection): readonly WorkspaceRegistryEntry[] {
    return db
      .prepare<WorkspaceRegistryRow>(
        `SELECT scope_key, visibility, position, created_at, updated_at, last_opened_at
         FROM ${tableName}
         ORDER BY position ASC, scope_key ASC`,
      )
      .all()
      .map(rowToEntry);
  }

  function transact<T>(operation: (db: DatabaseConnection) => T): T {
    if (database === getDatabase()) {
      return withTransaction(operation as SyncTransactionCallback<T>);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }

  function nextPosition(db: DatabaseConnection): number {
    const row = db
      .prepare<{ readonly next_position: number }>(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM ${tableName}`,
      )
      .get();
    return row?.next_position ?? 0;
  }

  function getFrom(
    db: DatabaseConnection,
    scopeKey: string,
  ): WorkspaceRegistryEntry | undefined {
    const row = db
      .prepare<WorkspaceRegistryRow>(
        `SELECT scope_key, visibility, position, created_at, updated_at, last_opened_at
         FROM ${tableName}
         WHERE scope_key = ?`,
      )
      .get(scopeKey);
    return row === undefined ? undefined : rowToEntry(row);
  }

  return {
    list(): readonly WorkspaceRegistryEntry[] {
      return listFrom(database);
    },

    ensureDiscovered(
      scopeKeys: readonly string[],
    ): readonly WorkspaceRegistryEntry[] {
      return transact((db) => {
        const discoveredAt = now();
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ${tableName}
            (scope_key, visibility, position, created_at, updated_at, last_opened_at)
           VALUES (?, 'visible', ?, ?, ?, ?)`,
        );
        const uniqueScopeKeys = [...new Set(scopeKeys)];
        let position = nextPosition(db);
        for (const scopeKey of uniqueScopeKeys) {
          const result = insert.run(
            scopeKey,
            position,
            discoveredAt,
            discoveredAt,
            discoveredAt,
          );
          if (result.changes > 0) {
            position += 1;
          }
        }
        return listFrom(db);
      });
    },

    open(scopeKey: string): WorkspaceRegistryEntry {
      return transact((db) => {
        const openedAt = now();
        const existing = getFrom(db, scopeKey);
        if (existing) {
          db.prepare(
            `UPDATE ${tableName}
             SET visibility = 'visible', updated_at = ?, last_opened_at = ?
             WHERE scope_key = ?`,
          ).run(openedAt, openedAt, scopeKey);
        } else {
          db.prepare(
            `INSERT INTO ${tableName}
              (scope_key, visibility, position, created_at, updated_at, last_opened_at)
             VALUES (?, 'visible', ?, ?, ?, ?)`,
          ).run(
            scopeKey,
            nextPosition(db),
            openedAt,
            openedAt,
            openedAt,
          );
        }
        const entry = getFrom(db, scopeKey);
        if (!entry) {
          throw new Error(`Workspace registry did not persist ${scopeKey}`);
        }
        return entry;
      });
    },

    hide(scopeKey: string): boolean {
      return transact((db) => {
        const hiddenAt = now();
        const result = db
          .prepare(
            `UPDATE ${tableName}
             SET visibility = 'hidden', updated_at = ?
             WHERE scope_key = ?`,
          )
          .run(hiddenAt, scopeKey);
        return result.changes > 0;
      });
    },
  };
}
