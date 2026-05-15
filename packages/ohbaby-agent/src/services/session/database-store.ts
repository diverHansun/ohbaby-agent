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

  function assertStoreAvailable(transactional: boolean): void {
    if (transactional && !activeTransaction) {
      throw new Error("Session transaction is no longer active");
    }
    if (!transactional && activeTransaction) {
      throw new Error(
        "Session transaction is active; use the provided transaction store",
      );
    }
  }

  function createStore(transactional: boolean): SessionStore {
    const store: SessionStore = {
      insert(session: Session): Promise<void> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transactional);
          insertRow(session);
        });
      },

      get(sessionId: string): Promise<Session | null> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transactional);
          const session = getRow(sessionId);
          return session ? cloneSession(session) : null;
        });
      },

      listByProject(
        projectId: string,
        options: ListSessionOptions = {},
      ): Promise<Session[]> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transactional);
          const limit = normalizeLimit(options.limit);
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
          assertStoreAvailable(transactional);
          const limit = normalizeLimit(options.limit);
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
          assertStoreAvailable(transactional);
          const normalizedLimit = normalizeLimit(limit) ?? 0;
          const rows = db
            .prepare<SessionRow>(
              `SELECT * FROM ${schema.session.tableName}
             ORDER BY updated_at DESC, created_at DESC
             LIMIT ?`,
            )
            .all(normalizedLimit);
          return rows.map(rowToSession).map(cloneSession);
        });
      },

      update(sessionId: string, patch: Partial<Session>): Promise<Session> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transactional);
          const existing = getRow(sessionId);
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
          writeRow(updated);
          return cloneSession(updated);
        });
      },

      remove(sessionId: string): Promise<void> {
        return withAsyncBoundary(() => {
          assertStoreAvailable(transactional);
          db.prepare(
            `DELETE FROM ${schema.session.tableName} WHERE id = ?`,
          ).run(sessionId);
        });
      },

      async withTransaction<T>(
        operation: (store: SessionStore) => Promise<T>,
      ): Promise<T> {
        assertStoreAvailable(transactional);
        if (activeTransaction) {
          throw new Error("Nested session transactions are not supported");
        }
        runWithBusyRetry(() => {
          db.exec("BEGIN IMMEDIATE");
        });
        activeTransaction = true;
        try {
          const result = await operation(createStore(true));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original store error.
          }
          throw error;
        } finally {
          activeTransaction = false;
        }
      },
    };

    return store;
  }

  return createStore(false);
}
