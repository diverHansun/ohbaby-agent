import {
  DuplicateSessionError,
  InvalidSessionLimitError,
  SessionNotFoundError,
} from "./errors.js";
import { sameSessionProjectRoot } from "./project-root.js";
import type { ListSessionOptions, Session, SessionStore } from "./types.js";

function cloneSession(session: Session): Session {
  return structuredClone(session);
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

function sortByUpdatedAtDesc(left: Session, right: Session): number {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return right.createdAt - left.createdAt;
}

export function createInMemorySessionStore(): SessionStore {
  let sessions = new Map<string, Session>();

  function cloneMap(input: Map<string, Session>): Map<string, Session> {
    return new Map(
      Array.from(input.entries()).map(([id, session]) => [
        id,
        cloneSession(session),
      ]),
    );
  }

  const store: SessionStore = {
    insert(session: Session): Promise<void> {
      if (sessions.has(session.id)) {
        return Promise.reject(new DuplicateSessionError(session.id));
      }
      sessions.set(session.id, cloneSession(session));
      return Promise.resolve();
    },

    get(sessionId: string): Promise<Session | null> {
      const session = sessions.get(sessionId);
      return Promise.resolve(session ? cloneSession(session) : null);
    },

    listByProject(
      projectId: string,
      options: ListSessionOptions = {},
    ): Promise<Session[]> {
      const limit = normalizeLimit(options.limit);
      const items = Array.from(sessions.values())
        .filter((session) => session.projectId === projectId)
        .filter(
          (session) =>
            options.status === undefined || session.status === options.status,
        )
        .sort(sortByUpdatedAtDesc)
        .slice(0, limit)
        .map(cloneSession);

      return Promise.resolve(items);
    },

    listByProjectRoot(
      projectRoot: string,
      options: ListSessionOptions = {},
    ): Promise<Session[]> {
      const limit = normalizeLimit(options.limit);
      const items = Array.from(sessions.values())
        .filter((session) =>
          sameSessionProjectRoot(session.projectRoot, projectRoot),
        )
        .filter(
          (session) =>
            options.status === undefined || session.status === options.status,
        )
        .sort(sortByUpdatedAtDesc)
        .slice(0, limit)
        .map(cloneSession);

      return Promise.resolve(items);
    },

    listChildren(
      parentId: string,
      options: ListSessionOptions = {},
    ): Promise<Session[]> {
      const limit = normalizeLimit(options.limit);
      const items = Array.from(sessions.values())
        .filter((session) => session.parentId === parentId)
        .filter(
          (session) =>
            options.status === undefined || session.status === options.status,
        )
        .sort(sortByUpdatedAtDesc)
        .slice(0, limit)
        .map(cloneSession);

      return Promise.resolve(items);
    },

    getRecent(limit: number): Promise<Session[]> {
      const normalizedLimit = normalizeLimit(limit) ?? 0;
      const items = Array.from(sessions.values())
        .filter((session) => !session.isSubagent)
        .sort(sortByUpdatedAtDesc)
        .slice(0, normalizedLimit)
        .map(cloneSession);

      return Promise.resolve(items);
    },

    update(sessionId: string, patch: Partial<Session>): Promise<Session> {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return Promise.reject(new SessionNotFoundError(sessionId));
      }

      const updated = {
        ...existing,
        ...patch,
        stats: patch.stats ? { ...patch.stats } : existing.stats,
        childrenIds: patch.childrenIds
          ? [...patch.childrenIds]
          : existing.childrenIds,
      };
      sessions.set(sessionId, cloneSession(updated));

      return Promise.resolve(cloneSession(updated));
    },

    remove(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
      return Promise.resolve();
    },

    async withTransaction<T>(
      operation: (store: SessionStore) => Promise<T>,
    ): Promise<T> {
      const snapshot = cloneMap(sessions);
      try {
        return await operation(store);
      } catch (error) {
        sessions = snapshot;
        throw error;
      }
    },
  };

  return store;
}
