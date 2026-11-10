import {
  getDatabase,
  runWriteTransaction,
  type DatabaseConnection,
} from "../database/index.js";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";
import { SideChatUnsupportedError } from "./errors.js";
import { readSessionRow } from "./database-store.js";
import type { Session } from "./types.js";

export type SessionArchiveErrorCode =
  | "SESSION_ARCHIVED"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ROOT"
  | "SESSION_NOT_ARCHIVED";
export class SessionArchiveError extends Error {
  constructor(
    readonly code: SessionArchiveErrorCode,
    readonly sessionId: string,
  ) {
    super(`${code}: ${sessionId}`);
    this.name = "SessionArchiveError";
  }
}
export interface RestoreArchivedSessionInput {
  readonly workspaceAvailable: boolean;
  readonly nextDirectoryExists: boolean;
  readonly defaultDirectory: string;
  readonly now: number;
}
export interface DeletedSessionData {
  readonly sessionIds: readonly string[];
  readonly checkpoints: readonly {
    readonly checkpointId: string;
    readonly workdir: string;
  }[];
}
function archivedRoot(db: DatabaseConnection, sessionId: string): Session {
  const session = readSessionRow(db, sessionId);
  if (!session) throw new SessionArchiveError("SESSION_NOT_FOUND", sessionId);
  if (session.parentId !== undefined || session.isSubagent)
    throw new SessionArchiveError("SESSION_NOT_ROOT", sessionId);
  if (session.status !== "archived")
    throw new SessionArchiveError("SESSION_NOT_ARCHIVED", sessionId);
  return session;
}

/** Filesystem checks happen before this synchronous transaction callback. */
export function restoreArchivedSession(
  sessionId: string,
  input: RestoreArchivedSessionInput,
  db: DatabaseConnection = getDatabase(),
): Promise<Session> {
  return runWriteTransaction(db, () => {
    const session = archivedRoot(db, sessionId);
    const workspace = input.workspaceAvailable
      ? session.workspaceDirectory
      : undefined;
    const pending = input.nextDirectoryExists
      ? session.pendingWorkingDirectory
      : (workspace ?? input.defaultDirectory);
    db.prepare(
      `UPDATE session SET workspace_directory = ?, pending_working_directory = ?, status = 'active', updated_at = ? WHERE id = ?`,
    ).run(workspace ?? null, pending ?? null, input.now, sessionId);
    const restored = readSessionRow(db, sessionId);
    if (!restored)
      throw new SessionArchiveError("SESSION_NOT_FOUND", sessionId);
    return restored;
  });
}

// UNION terminates even if corrupted parent links contain cycles; no bound ID array.
const SESSION_TREE = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM session WHERE id = ?
  UNION SELECT s.id FROM session s JOIN tree ON s.parent_id = tree.id
)`;

/** Checks and all relational deletes share one write transaction. */
export function deleteArchivedSession(
  sessionId: string,
  db: DatabaseConnection = getDatabase(),
): Promise<DeletedSessionData> {
  return runWriteTransaction(db, () => {
    archivedRoot(db, sessionId);
    assertTreeIdle(db, sessionId);
    return deleteTree(db, sessionId);
  });
}

/** Recheck after asynchronous side-chat shutdown, while no other process can admit work. */
export function archiveIdleRoot(
  db: DatabaseConnection,
  sessionId: string,
  now: number,
): Promise<Session> {
  return runWriteTransaction(db, (tx) => {
    const session = readSessionRow(tx, sessionId);
    if (!session) throw new SessionArchiveError("SESSION_NOT_FOUND", sessionId);
    if (session.sideChat) throw new SideChatUnsupportedError();
    if (session.isSubagent || session.parentId !== undefined)
      throw new SessionArchiveError("SESSION_NOT_ROOT", sessionId);
    if (
      tx
        .prepare(
          "SELECT 1 FROM session WHERE json_extract(data, '$.sideChat.mainSessionId') = ? LIMIT 1",
        )
        .get(sessionId)
    )
      throw new SessionRunBusyError(sessionId, []);
    assertTreeIdle(tx, sessionId);
    tx.prepare(
      "UPDATE session SET status = 'archived', updated_at = ? WHERE id = ?",
    ).run(now, sessionId);
    return { ...session, status: "archived", updatedAt: now };
  });
}

/** The actual durable admission must not follow a concurrent archive commit. */
export function assertActiveSessionForWork(
  db: DatabaseConnection,
  sessionId: string,
): void {
  const archived = db
    .prepare<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parent_id, status) AS (
      SELECT id, parent_id, status FROM session WHERE id = ?
      UNION SELECT s.id, s.parent_id, s.status FROM session s JOIN ancestors a ON s.id = a.parent_id
    ) SELECT id FROM ancestors WHERE status = 'archived' LIMIT 1`,
    )
    .get(sessionId);
  if (archived) throw new SessionArchiveError("SESSION_ARCHIVED", archived.id);
}

export function deleteSideChatSession(
  db: DatabaseConnection,
  sessionId: string,
  options: { readonly skipBusyCheck?: boolean } = {},
): Promise<DeletedSessionData> {
  return runWriteTransaction(db, (tx) => {
    const session = readSessionRow(tx, sessionId);
    if (!session) return { sessionIds: [], checkpoints: [] };
    if (!session.sideChat)
      throw new SideChatUnsupportedError("Only a side chat can be closed");
    if (!options.skipBusyCheck) assertTreeIdle(tx, sessionId);
    return deleteTree(tx, sessionId);
  });
}

function assertTreeIdle(db: DatabaseConnection, sessionId: string): void {
  // Older versions allowed archiving busy sessions. Do not destroy their work.
  const activeRuns = db
    .prepare<{
      run_id: string;
    }>(
      `${SESSION_TREE} SELECT run_id FROM run_ledger WHERE session_id IN (SELECT id FROM tree) AND status IN ('pending', 'running')`,
    )
    .all(sessionId);
  const pendingPrompt = db
    .prepare(
      `${SESSION_TREE} SELECT 1 FROM prompt_submission WHERE session_id IN (SELECT id FROM tree) AND status IN ('queued', 'starting', 'running') LIMIT 1`,
    )
    .get(sessionId);
  if (activeRuns.length > 0 || pendingPrompt)
    throw new SessionRunBusyError(
      sessionId,
      activeRuns.map((run) => run.run_id),
    );
}

function deleteTree(
  db: DatabaseConnection,
  sessionId: string,
): DeletedSessionData {
  const sessionIds = db
    .prepare<{ id: string }>(`${SESSION_TREE} SELECT id FROM tree`)
    .all(sessionId)
    .map((row) => row.id);
  const checkpoints = db
    .prepare<{
      checkpointId: string;
      workdir: string;
    }>(
      `${SESSION_TREE} SELECT checkpoint_id AS checkpointId, workdir FROM snapshot_checkpoint WHERE session_id IN (SELECT id FROM tree)`,
    )
    .all(sessionId);
  db.prepare(
    `${SESSION_TREE} DELETE FROM goal_record WHERE session_id IN (SELECT id FROM tree)`,
  ).run(sessionId);
  db.prepare(
    `${SESSION_TREE} DELETE FROM subagent_execution WHERE parent_session_id IN (SELECT id FROM tree) OR root_session_id IN (SELECT id FROM tree) OR child_session_id IN (SELECT id FROM tree)`,
  ).run(sessionId);
  db.prepare(
    `${SESSION_TREE} DELETE FROM subagent_instance WHERE parent_session_id IN (SELECT id FROM tree)`,
  ).run(sessionId);
  db.prepare(
    `${SESSION_TREE} DELETE FROM session WHERE id IN (SELECT id FROM tree)`,
  ).run(sessionId);
  return { sessionIds, checkpoints };
}
