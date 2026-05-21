import {
  getDatabase,
  runWithBusyRetry,
  schema,
  type DatabaseConnection,
} from "../database/index.js";
import {
  DuplicateSessionError,
  InvalidSessionLimitError,
  SessionNotFoundError,
} from "./errors.js";
import type { ListSessionOptions, Session, SessionStore } from "./types.js";

interface SessionRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_root: string;
  readonly agent: string | null;
  readonly parent_id: string | null;
  readonly title: string | null;
  readonly status: Session["status"];
  readonly created_at: number;
  readonly updated_at: number;
  readonly message_count: number;
  readonly last_message_at: number | null;
  readonly data: string;
}

interface SessionData {
  readonly childrenIds?: readonly string[];
  readonly isSubagent?: boolean;
}

interface DatabaseSessionStoreOptions {
  readonly db?: DatabaseConnection;
}

interface SessionTransactionState {
  active: boolean;
  readonly upserts: Map<string, Session>;
  readonly removals: Set<string>;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new InvalidSessionLimitError();
  }
  return limit;
}

function encodeData(session: Session): string {
  const data: SessionData = {
    childrenIds: session.childrenIds,
    isSubagent: session.isSubagent,
  };
  return JSON.stringify(data);
}

function decodeData(row: SessionRow): SessionData {
  return JSON.parse(row.data) as SessionData;
}

function rowToSession(row: SessionRow): Session {
  const data = decodeData(row);
  return {
    id: row.id,
    projectId: row.project_id,
    projectRoot: row.project_root,
    title: row.title ?? "",
    agentName: row.agent ?? "default",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    stats: {
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at ?? undefined,
    },
    parentId: row.parent_id ?? undefined,
    childrenIds: data.childrenIds ?? [],
    isSubagent: data.isSubagent ?? row.parent_id !== null,
  };
}

function cloneSession(session: Session): Session {
  return structuredClone(session);
}

function sortByUpdatedAtDesc(left: Session, right: Session): number {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return right.createdAt - left.createdAt;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}

function bindLimit(sql: string, limit: number | undefined): string {
  return limit === undefined ? sql : `${sql} LIMIT ${String(limit)}`;
}

export function createDatabaseSessionStore(
  options: DatabaseSessionStoreOptions = {},
): SessionStore {
  const db = options.db ?? getDatabase();
  let activeTransaction = false;

  function insertRow(session: Session): void {
    try {
      db.prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.projectId,
        session.projectRoot,
        session.agentName,
        session.parentId ?? null,
        session.title,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.stats.messageCount,
        session.stats.lastMessageAt ?? null,
        encodeData(session),
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateSessionError(session.id);
      }
      throw error;
    }
  }

  function writeRow(session: Session): void {
    db.prepare(
      `UPDATE ${schema.session.tableName}
       SET project_id = ?, project_root = ?, agent = ?, parent_id = ?, title = ?, status = ?,
           created_at = ?, updated_at = ?, message_count = ?, last_message_at = ?, data = ?
       WHERE id = ?`,
    ).run(
      session.projectId,
      session.projectRoot,
      session.agentName,
      session.parentId ?? null,
      session.title,
      session.status,
      session.createdAt,
      session.updatedAt,
      session.stats.messageCount,
      session.stats.lastMessageAt ?? null,
      encodeData(session),
      session.id,
    );
  }

  function upsertRow(session: Session): void {
    db.prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        project_root = excluded.project_root,
        agent = excluded.agent,
        parent_id = excluded.parent_id,
        title = excluded.title,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        message_count = excluded.message_count,
        last_message_at = excluded.last_message_at,
        data = excluded.data`,
    ).run(
      session.id,
      session.projectId,
      session.projectRoot,
      session.agentName,
      session.parentId ?? null,
      session.title,
      session.status,
      session.createdAt,
      session.updatedAt,
      session.stats.messageCount,
      session.stats.lastMessageAt ?? null,
      encodeData(session),
    );
  }

  function getRow(sessionId: string): Session | null {
    const row = db
      .prepare<SessionRow>(
        `SELECT * FROM ${schema.session.tableName} WHERE id = ?`,
      )
      .get(sessionId);
    return row ? rowToSession(row) : null;
  }

  async function withAsyncBoundary<T>(operation: () => T): Promise<T> {
    await Promise.resolve();
    return operation();
  }

  function assertStoreAvailable(transaction?: SessionTransactionState): void {
    if (transaction && !transaction.active) {
      throw new Error("Session transaction is no longer active");
    }
    if (!transaction && activeTransaction) {
      throw new Error(
        "Session transaction is active; use the provided transaction store",
      );
    }
  }

  function getTransactionSession(
    transaction: SessionTransactionState,
    sessionId: string,
  ): Session | null {
    if (transaction.removals.has(sessionId)) {
      return null;
    }
    const staged = transaction.upserts.get(sessionId);
    if (staged) {
      return cloneSession(staged);
    }
    const session = getRow(sessionId);
    return session ? cloneSession(session) : null;
  }

  function listTransactionSessions(
    transaction: SessionTransactionState,
  ): Session[] {
    const rows = db
      .prepare<SessionRow>(`SELECT * FROM ${schema.session.tableName}`)
      .all();
    const sessions = new Map<string, Session>();
    for (const row of rows) {
      sessions.set(row.id, rowToSession(row));
    }
    for (const sessionId of transaction.removals) {
      sessions.delete(sessionId);
    }
    for (const [sessionId, session] of transaction.upserts) {
      sessions.set(sessionId, cloneSession(session));
    }
    return Array.from(sessions.values());
  }

  function commitTransaction(transaction: SessionTransactionState): void {
    if (transaction.upserts.size === 0 && transaction.removals.size === 0) {
      return;
    }
    runWithBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
    });
    try {
      for (const sessionId of transaction.removals) {
        db.prepare(`DELETE FROM ${schema.session.tableName} WHERE id = ?`).run(
          sessionId,
        );
      }
      for (const session of transaction.upserts.values()) {
        upsertRow(session);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original store error.
      }
      throw error;
    }
  }

  function createStore(transaction?: SessionTransactionState): SessionStore {
    const store: SessionStore = {
      insert(session: Session): Promise<void> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          if (transaction) {
            if (getTransactionSession(transaction, session.id)) {
              throw new DuplicateSessionError(session.id);
            }
            transaction.removals.delete(session.id);
            transaction.upserts.set(session.id, cloneSession(session));
            return;
          }
          insertRow(session);
        });
      },

      get(sessionId: string): Promise<Session | null> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          const session = transaction
            ? getTransactionSession(transaction, sessionId)
            : getRow(sessionId);
          return session ? cloneSession(session) : null;
        });
      },

      listByProject(
        projectId: string,
        options: ListSessionOptions = {},
      ): Promise<Session[]> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          const limit = normalizeLimit(options.limit);
          if (transaction) {
            return listTransactionSessions(transaction)
              .filter((session) => session.projectId === projectId)
              .filter(
                (session) =>
                  options.status === undefined ||
                  session.status === options.status,
              )
              .sort(sortByUpdatedAtDesc)
              .slice(0, limit)
              .map(cloneSession);
          }
          const clauses = ["project_id = ?"];
          const params: (string | number)[] = [projectId];
          if (options.status !== undefined) {
            clauses.push("status = ?");
            params.push(options.status);
          }
          const rows = db
            .prepare<SessionRow>(
              bindLimit(
                `SELECT * FROM ${schema.session.tableName}
               WHERE ${clauses.join(" AND ")}
               ORDER BY updated_at DESC, created_at DESC`,
                limit,
              ),
            )
            .all(...params);
          return rows.map(rowToSession).map(cloneSession);
        });
      },

      listChildren(
        parentId: string,
        options: ListSessionOptions = {},
      ): Promise<Session[]> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          const limit = normalizeLimit(options.limit);
          if (transaction) {
            return listTransactionSessions(transaction)
              .filter((session) => session.parentId === parentId)
              .filter(
                (session) =>
                  options.status === undefined ||
                  session.status === options.status,
              )
              .sort(sortByUpdatedAtDesc)
              .slice(0, limit)
              .map(cloneSession);
          }
          const clauses = ["parent_id = ?"];
          const params: (string | number)[] = [parentId];
          if (options.status !== undefined) {
            clauses.push("status = ?");
            params.push(options.status);
          }
          const rows = db
            .prepare<SessionRow>(
              bindLimit(
                `SELECT * FROM ${schema.session.tableName}
               WHERE ${clauses.join(" AND ")}
               ORDER BY updated_at DESC, created_at DESC`,
                limit,
              ),
            )
            .all(...params);
          return rows.map(rowToSession).map(cloneSession);
        });
      },

      getRecent(limit: number): Promise<Session[]> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          const normalizedLimit = normalizeLimit(limit) ?? 0;
          if (transaction) {
            return listTransactionSessions(transaction)
              .filter((session) => !session.isSubagent)
              .sort(sortByUpdatedAtDesc)
              .slice(0, normalizedLimit)
              .map(cloneSession);
          }
          const rows = db
            .prepare<SessionRow>(
              `SELECT * FROM ${schema.session.tableName}
             WHERE parent_id IS NULL
             ORDER BY updated_at DESC, created_at DESC
             LIMIT ?`,
            )
            .all(normalizedLimit);
          return rows.map(rowToSession).map(cloneSession);
        });
      },

      update(sessionId: string, patch: Partial<Session>): Promise<Session> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          const existing = transaction
            ? getTransactionSession(transaction, sessionId)
            : getRow(sessionId);
          if (!existing) {
            throw new SessionNotFoundError(sessionId);
          }
          const updated: Session = {
            ...existing,
            ...patch,
            id: existing.id,
            stats: patch.stats ? { ...patch.stats } : existing.stats,
            childrenIds: patch.childrenIds
              ? [...patch.childrenIds]
              : existing.childrenIds,
          };
          if (transaction) {
            transaction.removals.delete(sessionId);
            transaction.upserts.set(sessionId, cloneSession(updated));
          } else {
            writeRow(updated);
          }
          return cloneSession(updated);
        });
      },

      remove(sessionId: string): Promise<void> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transaction);
          if (transaction) {
            transaction.upserts.delete(sessionId);
            transaction.removals.add(sessionId);
            return;
          }
          db.prepare(
            `DELETE FROM ${schema.session.tableName} WHERE id = ?`,
          ).run(sessionId);
        });
      },

      async withTransaction<T>(
        operation: (store: SessionStore) => Promise<T>,
      ): Promise<T> {
        assertStoreAvailable(transaction);
        if (activeTransaction) {
          throw new Error("Nested session transactions are not supported");
        }
        activeTransaction = true;
        const state: SessionTransactionState = {
          active: true,
          upserts: new Map(),
          removals: new Set(),
        };
        try {
          const result = await operation(createStore(state));
          commitTransaction(state);
          return result;
        } finally {
          state.active = false;
          activeTransaction = false;
        }
      },
    };

    return store;
  }

  return createStore();
}
