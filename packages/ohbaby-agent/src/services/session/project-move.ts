import {
  getDatabase,
  runWriteTransaction,
  type DatabaseConnection,
} from "../database/index.js";
import {
  readSessionRow,
  writeSessionProjectBinding,
  type SessionProjectBinding,
} from "./database-store.js";
import {
  resolveSessionProjectBinding,
  sameSessionProjectRoot,
} from "./project-root.js";
import type { Session } from "./types.js";

export type SessionProjectMoveErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ROOT"
  | "SESSION_ARCHIVED";

export class SessionProjectMoveError extends Error {
  constructor(
    readonly code: SessionProjectMoveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionProjectMoveError";
  }
}

export interface SessionProjectMovePlan {
  readonly sessionId: string;
  readonly binding: SessionProjectBinding;
  /** Directory whose workspace must own the session's queued prompts. */
  readonly queueRoot: string;
  /** Queued prompts currently held by another directory's workspace. */
  readonly needsQueueHandover: boolean;
}

/**
 * Plans a project change. `projectDirectory` must already be a validated
 * workspace scope; null removes the session from its project.
 */
export function planSessionProjectMove(
  sessionId: string,
  projectDirectory: string | null,
  db: DatabaseConnection = getDatabase(),
): SessionProjectMovePlan {
  const session = readSessionRow(db, sessionId);
  if (!session) {
    throw new SessionProjectMoveError(
      "SESSION_NOT_FOUND",
      `Session not found: ${sessionId}`,
    );
  }
  assertMovable(session);
  const binding = resolveSessionProjectBinding(session, projectDirectory);
  const queueRoot = binding.pendingProjectRoot ?? session.projectRoot;
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
      (row) => !sameSessionProjectRoot(row.scope_key, queueRoot),
    ),
  };
}

/** Commits a plan that has no queued prompts to hand over. */
export function commitSessionProjectMove(
  plan: SessionProjectMovePlan,
  db: DatabaseConnection = getDatabase(),
  now: () => number = Date.now,
): Promise<Session> {
  return runWriteTransaction(db, () => {
    const session = readSessionRow(db, plan.sessionId);
    if (!session) {
      throw new SessionProjectMoveError(
        "SESSION_NOT_FOUND",
        `Session not found: ${plan.sessionId}`,
      );
    }
    assertMovable(session);
    return writeSessionProjectBinding(db, plan.sessionId, plan.binding, now());
  });
}

function assertMovable(session: Session): void {
  if (session.parentId !== undefined || session.isSubagent) {
    throw new SessionProjectMoveError(
      "SESSION_NOT_ROOT",
      "Only root sessions can change project",
    );
  }
  if (session.status !== "active") {
    throw new SessionProjectMoveError(
      "SESSION_ARCHIVED",
      "Archived sessions cannot change project",
    );
  }
}
