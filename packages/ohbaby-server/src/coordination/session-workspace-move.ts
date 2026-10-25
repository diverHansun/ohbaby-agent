import {
  SessionWorkspaceMoveError,
  type CoreSession,
  type RestoreArchivedSessionInput,
  type DeletedSessionData,
  type GlobalSessionPage,
  type SessionWorkspaceMovePlan,
  type SessionSearchPage,
} from "ohbaby-agent";

/** Shared-database reads and writes behind the daemon's global session routes. */
export interface GlobalSessionCatalog {
  list(input: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly status?: "active" | "archived";
  }): GlobalSessionPage;
  search(input: {
    readonly query: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): SessionSearchPage;
  restore(
    sessionId: string,
    input: RestoreArchivedSessionInput,
  ): Promise<CoreSession>;
  delete(sessionId: string): Promise<DeletedSessionData>;
  get(sessionId: string): CoreSession | null;
  planMove(
    sessionId: string,
    workspaceDirectory: string | null,
  ): SessionWorkspaceMovePlan;
  commitMove(plan: SessionWorkspaceMovePlan): Promise<CoreSession>;
}

/** A workspace that can take over a moved session's queued prompts. */
export interface SessionQueueOwner {
  adoptSessionWorkspaceMove?(plan: SessionWorkspaceMovePlan): Promise<void>;
}

export interface SessionWorkspaceMoveDeps {
  readonly catalog: GlobalSessionCatalog;
  /** Canonical workspace scope; rejects missing or non-directory paths. */
  readonly resolveScope: (directory: string) => Promise<string>;
  readonly isDefaultDirectory: (directory: string) => boolean;
  /** Makes a workspace that was never opened visible; hidden ones stay hidden. */
  readonly discoverWorkspace?: (directory: string) => Promise<unknown>;
  readonly loadQueueOwner: (
    directory: string,
  ) => Promise<SessionQueueOwner | undefined>;
}

export class DefaultDirectoryNotWorkspaceError extends Error {
  readonly code = "DEFAULT_DIRECTORY_NOT_WORKSPACE";

  constructor() {
    super("The default directory cannot be used as a workspace");
    this.name = "DefaultDirectoryNotWorkspaceError";
  }
}

/**
 * Moves a session into a workspace, or out of its workspace with `null`.
 * Queued prompts held by another directory move with the binding in the
 * target workspace's own write; otherwise the binding is written directly.
 */
export async function moveSessionWorkspace(
  deps: SessionWorkspaceMoveDeps,
  sessionId: string,
  requestedDirectory: string | null,
): Promise<CoreSession> {
  let workspaceDirectory: string | null = null;
  if (requestedDirectory !== null) {
    workspaceDirectory = await deps.resolveScope(requestedDirectory);
    if (deps.isDefaultDirectory(workspaceDirectory)) {
      throw new DefaultDirectoryNotWorkspaceError();
    }
    await deps.discoverWorkspace?.(workspaceDirectory);
  }
  const plan = deps.catalog.planMove(sessionId, workspaceDirectory);
  if (!plan.needsQueueHandover) {
    return deps.catalog.commitMove(plan);
  }
  const owner = await deps.loadQueueOwner(plan.queueRoot);
  if (!owner?.adoptSessionWorkspaceMove) {
    throw new Error("Workspace cannot take over queued prompts");
  }
  await owner.adoptSessionWorkspaceMove(plan);
  const session = deps.catalog.get(sessionId);
  if (!session) {
    throw new SessionWorkspaceMoveError(
      "SESSION_NOT_FOUND",
      `Session not found: ${sessionId}`,
    );
  }
  return session;
}
