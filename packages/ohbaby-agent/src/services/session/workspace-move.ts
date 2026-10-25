import {
  getDatabase,
  runWriteTransaction,
  type DatabaseConnection,
} from "../database/index.js";
import {
  readSessionRow,
  writeSessionWorkspaceBinding,
  type SessionWorkspaceBinding,
} from "./database-store.js";
import {
  resolveSessionWorkspaceBinding,
  sameSessionDirectory,
} from "./working-directory.js";
import type { Session } from "./types.js";

export type SessionWorkspaceMoveErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ROOT"
  | "SESSION_ARCHIVED";

export class SessionWorkspaceMoveError extends Error {
  constructor(
    readonly code: SessionWorkspaceMoveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionWorkspaceMoveError";
  }
}

export interface SessionWorkspaceMovePlan {
  readonly sessionId: string;
  readonly binding: SessionWorkspaceBinding;
  /** Directory whose workspace must own the session's queued prompts. */
  readonly queueRoot: string;
  /** Queued prompts currently held by another directory's workspace. */
  readonly needsQueueHandover: boolean;
}

/**
 * Plans a workspace change. `workspaceDirectory` must already be a validated
 * workspace scope; null removes the session from its workspace.
 */
export function planSessionWorkspaceMove(
  sessionId: string,
  workspaceDirectory: string | null,
  db: DatabaseConnection = getDatabase(),
): SessionWorkspaceMovePlan {
  const session = readSessionRow(db, sessionId);
  if (!session) {
    throw new SessionWorkspaceMoveError(
      "SESSION_NOT_FOUND",
      `Session not found: ${sessionId}`,
    );
  }
  assertMovable(session);
  const binding = resolveSessionWorkspaceBinding(session, workspaceDirectory);
  const queueRoot = binding.pendingWorkingDirectory ?? session.workingDirectory;
  const queuedScopes = db
    .prepare<{ readonly scope_key: string }>(
      `SELECT DISTINCT scope_key FROM prompt_submission
       WHERE session_id = ? AND status = 'queued'`,
    )
    .all(sessionId);
  return {
    sessionId,
    binding,
    queueRoot,
    needsQueueHandover: queuedScopes.some(
      (row) => !sameSessionDirectory(row.scope_key, queueRoot),
    ),
  };
}

/** Commits a plan that has no queued prompts to hand over. */
export function commitSessionWorkspaceMove(
  plan: SessionWorkspaceMovePlan,
  db: DatabaseConnection = getDatabase(),
  now: () => number = Date.now,
): Promise<Session> {
  return runWriteTransaction(db, () => {
    const session = readSessionRow(db, plan.sessionId);
    if (!session) {
      throw new SessionWorkspaceMoveError(
        "SESSION_NOT_FOUND",
        `Session not found: ${plan.sessionId}`,
      );
    }
    assertMovable(session);
    return writeSessionWorkspaceBinding(
      db,
      plan.sessionId,
      plan.binding,
      now(),
    );
  });
}

function assertMovable(session: Session): void {
  if (session.parentId !== undefined || session.isSubagent) {
    throw new SessionWorkspaceMoveError(
      "SESSION_NOT_ROOT",
      "Only root sessions can change workspace",
    );
  }
  if (session.status !== "active") {
    throw new SessionWorkspaceMoveError(
      "SESSION_ARCHIVED",
      "Archived sessions cannot change workspace",
    );
  }
}
