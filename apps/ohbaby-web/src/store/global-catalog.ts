import type { UiGlobalSession } from "ohbaby-sdk";
import type { WorkspaceScopeSummary } from "../api/daemon/wire.js";

export type CatalogStatus = "loading" | "ready" | "error";

/**
 * Directory-independent server state: projects and the loaded range of the
 * global session list. It survives instance switches, unlike the main store.
 */
export interface GlobalCatalogSnapshot {
  readonly projects: readonly WorkspaceScopeSummary[];
  /** Working directory for sessions without a project; null until known. */
  readonly defaultWorkspace: string | null;
  readonly projectsStatus: CatalogStatus;
  /** Loaded range, newest first, unique by id. */
  readonly sessions: readonly UiGlobalSession[];
  /** Set while more pages exist beyond the loaded range. */
  readonly nextCursor: string | undefined;
  readonly sessionsStatus: CatalogStatus;
  readonly sessionsError: string | null;
  readonly loadingMore: boolean;
}

export interface GlobalCatalogStore {
  getSnapshot(): GlobalCatalogSnapshot;
  subscribe(listener: () => void): () => void;
  setProjects(
    projects: readonly WorkspaceScopeSummary[],
    defaultWorkspace: string | null,
  ): void;
  failProjects(): void;
  /** Replaces the whole loaded range with a fresh, complete read. */
  replaceSessions(
    sessions: readonly UiGlobalSession[],
    nextCursor: string | undefined,
  ): void;
  appendSessions(
    sessions: readonly UiGlobalSession[],
    nextCursor: string | undefined,
  ): void;
  /** Inserts or replaces one row, keeping newest-first order. */
  upsertSession(session: UiGlobalSession): void;
  removeSession(sessionId: string): void;
  /** Failures keep old rows; only an empty catalog shows the error. */
  failSessions(message: string): void;
  setLoadingMore(loading: boolean): void;
}

const INITIAL: GlobalCatalogSnapshot = {
  projects: [],
  defaultWorkspace: null,
  projectsStatus: "loading",
  sessions: [],
  nextCursor: undefined,
  sessionsStatus: "loading",
  sessionsError: null,
  loadingMore: false,
};

export function createGlobalCatalogStore(): GlobalCatalogStore {
  let snapshot = INITIAL;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<GlobalCatalogSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): GlobalCatalogSnapshot => snapshot,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setProjects: (projects, defaultWorkspace): void => {
      publish({ projects, defaultWorkspace, projectsStatus: "ready" });
    },
    failProjects: (): void => {
      publish({ projectsStatus: "error" });
    },
    replaceSessions: (sessions, nextCursor): void => {
      publish({
        sessions: uniqueSessions(sessions),
        nextCursor,
        sessionsStatus: "ready",
        sessionsError: null,
      });
    },
    appendSessions: (sessions, nextCursor): void => {
      publish({
        sessions: uniqueSessions([...snapshot.sessions, ...sessions]),
        nextCursor,
        sessionsStatus: "ready",
        sessionsError: null,
      });
    },
    upsertSession: (session): void => {
      publish({
        sessions: sortSessions([
          ...snapshot.sessions.filter((value) => value.id !== session.id),
          session,
        ]),
      });
    },
    removeSession: (sessionId): void => {
      publish({
        sessions: snapshot.sessions.filter((value) => value.id !== sessionId),
      });
    },
    failSessions: (message): void => {
      publish({ sessionsStatus: "error", sessionsError: message });
    },
    setLoadingMore: (loadingMore): void => {
      publish({ loadingMore });
    },
  };
}

/** Keeps the first occurrence; later pages may repeat a row that moved up. */
function uniqueSessions(
  sessions: readonly UiGlobalSession[],
): readonly UiGlobalSession[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

/** Server order: updatedAt descending, then id descending. */
function sortSessions(
  sessions: readonly UiGlobalSession[],
): readonly UiGlobalSession[] {
  return [...sessions].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
  );
}
