import {
  SessionProjectMoveError,
  type CoreSession,
  type GlobalSessionPage,
  type SessionProjectMovePlan,
  type SessionSearchPage,
} from "ohbaby-agent";

/** Shared-database reads and writes behind the daemon's global session routes. */
export interface GlobalSessionCatalog {
  list(input: {
    readonly limit?: number;
    readonly cursor?: string;
  }): GlobalSessionPage;
  search(input: {
    readonly query: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): SessionSearchPage;
  get(sessionId: string): CoreSession | null;
  planMove(
    sessionId: string,
    projectDirectory: string | null,
  ): SessionProjectMovePlan;
  commitMove(plan: SessionProjectMovePlan): Promise<CoreSession>;
}

/** A workspace that can take over a moved session's queued prompts. */
export interface SessionQueueOwner {
  adoptSessionProjectMove?(plan: SessionProjectMovePlan): Promise<void>;
}

export interface SessionProjectMoveDeps {
  readonly catalog: GlobalSessionCatalog;
  /** Canonical workspace scope; rejects missing or non-directory paths. */
  readonly resolveScope: (directory: string) => Promise<string>;
  readonly isDefaultWorkspace: (directory: string) => boolean;
  /** Makes a project that was never opened visible; hidden ones stay hidden. */
  readonly discoverProject?: (directory: string) => Promise<unknown>;
  readonly loadQueueOwner: (
    directory: string,
  ) => Promise<SessionQueueOwner | undefined>;
}

export class DefaultWorkspaceNotProjectError extends Error {
  readonly code = "DEFAULT_WORKSPACE_NOT_PROJECT";

  constructor() {
    super("The default workspace is not a project");
    this.name = "DefaultWorkspaceNotProjectError";
  }
}

/**
 * Moves a session into a project, or out of its project with `null`.
 * Queued prompts held by another directory move with the binding in the
 * target workspace's own write; otherwise the binding is written directly.
 */
export async function moveSessionProject(
  deps: SessionProjectMoveDeps,
  sessionId: string,
  requestedDirectory: string | null,
): Promise<CoreSession> {
  let projectDirectory: string | null = null;
  if (requestedDirectory !== null) {
    projectDirectory = await deps.resolveScope(requestedDirectory);
    if (deps.isDefaultWorkspace(projectDirectory)) {
      throw new DefaultWorkspaceNotProjectError();
    }
    await deps.discoverProject?.(projectDirectory);
  }
  const plan = deps.catalog.planMove(sessionId, projectDirectory);
  if (!plan.needsQueueHandover) {
    return deps.catalog.commitMove(plan);
  }
  const owner = await deps.loadQueueOwner(plan.queueRoot);
  if (!owner?.adoptSessionProjectMove) {
    throw new Error("Workspace cannot take over queued prompts");
  }
  await owner.adoptSessionProjectMove(plan);
  const session = deps.catalog.get(sessionId);
  if (!session) {
    throw new SessionProjectMoveError(
      "SESSION_NOT_FOUND",
      `Session not found: ${sessionId}`,
    );
  }
  return session;
}
