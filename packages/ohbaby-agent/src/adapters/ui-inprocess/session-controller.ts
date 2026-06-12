import type { UiSession, UiSnapshot } from "ohbaby-sdk";
import type {
  Session as CoreSession,
  SessionManager,
} from "../../services/session/index.js";
import { sameSessionProjectRoot } from "../../services/session/index.js";

export type InProcessSessionManager = Pick<
  SessionManager,
  | "create"
  | "get"
  | "getRecent"
  | "listByProject"
  | "listByProjectRoot"
  | "update"
> &
  Partial<
    Pick<SessionManager, "findReusableEmptyPrimary" | "incrementStats">
  >;

export interface ResolveSessionForNewPromptInput {
  readonly createSession: (id?: string) => Promise<UiSession>;
  readonly explicitSessionId?: string;
  readonly getUiSession: (id: string) => Promise<UiSession | null | undefined>;
  readonly projectRoot: string;
  readonly sessionManager?: InProcessSessionManager;
  readonly snapshot: UiSnapshot;
}

export interface ResolvedSessionForNewPrompt {
  readonly coreSession?: CoreSession;
  readonly isNewSession: boolean;
  readonly session: UiSession;
}

export function sessionMetadataToUiSession(session: CoreSession): UiSession {
  return {
    createdAt: new Date(session.createdAt).toISOString(),
    id: session.id,
    messages: [],
    projectRoot: session.projectRoot,
    title: session.title,
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

export function isPrimarySession(session: CoreSession): boolean {
  return !session.isSubagent;
}

export function sortCoreSessionsByUpdatedAtDesc(
  left: CoreSession,
  right: CoreSession,
): number {
  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return right.createdAt - left.createdAt;
}

export function sortUiSessionsByUpdatedAtDesc(
  left: UiSession,
  right: UiSession,
): number {
  const leftUpdatedAt = parseUiTimestamp(left.updatedAt) ?? 0;
  const rightUpdatedAt = parseUiTimestamp(right.updatedAt) ?? 0;
  if (rightUpdatedAt !== leftUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return (
    (parseUiTimestamp(right.createdAt) ?? 0) -
    (parseUiTimestamp(left.createdAt) ?? 0)
  );
}

export function parseUiTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function isReusableUiSession(
  session: UiSession,
  projectRoot: string,
): boolean {
  return (
    session.messages.length === 0 &&
    sameSessionProjectRoot(session.projectRoot, projectRoot)
  );
}

function isReusableCoreSession(
  session: CoreSession | null | undefined,
  projectRoot: string,
): session is CoreSession {
  return (
    session !== null &&
    session !== undefined &&
    isPrimarySession(session) &&
    session.stats.messageCount === 0 &&
    sameSessionProjectRoot(session.projectRoot, projectRoot)
  );
}

function snapshotSession(
  snapshot: UiSnapshot,
  sessionId: string,
): UiSession | undefined {
  return snapshot.sessions.find((session) => session.id === sessionId);
}

async function resolveUiSession(
  input: ResolveSessionForNewPromptInput,
  sessionId: string,
): Promise<UiSession | null> {
  const session = snapshotSession(input.snapshot, sessionId);
  if (session) {
    return session;
  }
  return (await input.getUiSession(sessionId)) ?? null;
}

function withCoreProjectRoot(
  session: UiSession,
  coreSession: CoreSession | null | undefined,
): UiSession {
  if (session.projectRoot || !coreSession) {
    return session;
  }
  return {
    ...session,
    projectRoot: coreSession.projectRoot,
  };
}

async function resolveReusableUiSession(input: {
  readonly projectRoot: string;
  readonly session: UiSession | null | undefined;
  readonly sessionManager?: InProcessSessionManager;
}): Promise<ResolvedSessionForNewPrompt | null> {
  if (!input.session || !isReusableUiSession(input.session, input.projectRoot)) {
    return null;
  }
  if (!input.sessionManager) {
    return {
      isNewSession: false,
      session: input.session,
    };
  }

  const coreSession = await input.sessionManager.get(input.session.id);
  if (!isReusableCoreSession(coreSession, input.projectRoot)) {
    return null;
  }
  return {
    coreSession,
    isNewSession: false,
    session: withCoreProjectRoot(input.session, coreSession),
  };
}

export async function resolveSessionForNewPrompt(
  input: ResolveSessionForNewPromptInput,
): Promise<ResolvedSessionForNewPrompt> {
  if (input.explicitSessionId) {
    const [uiSession, coreSession] = await Promise.all([
      resolveUiSession(input, input.explicitSessionId),
      input.sessionManager?.get(input.explicitSessionId),
    ]);
    if (uiSession) {
      return {
        ...(coreSession ? { coreSession } : {}),
        isNewSession: false,
        session: withCoreProjectRoot(uiSession, coreSession),
      };
    }
    if (coreSession) {
      return {
        coreSession,
        isNewSession: false,
        session: sessionMetadataToUiSession(coreSession),
      };
    }
    return {
      isNewSession: true,
      session: await input.createSession(input.explicitSessionId),
    };
  }

  if (input.snapshot.activeSessionId) {
    const activeSession = await resolveUiSession(
      input,
      input.snapshot.activeSessionId,
    );
    const resolved = await resolveReusableUiSession({
      projectRoot: input.projectRoot,
      session: activeSession,
      sessionManager: input.sessionManager,
    });
    if (resolved) {
      return resolved;
    }
  }

  const reusableCoreSession =
    await input.sessionManager?.findReusableEmptyPrimary?.(input.projectRoot);
  if (isReusableCoreSession(reusableCoreSession, input.projectRoot)) {
    const uiSession = await resolveUiSession(input, reusableCoreSession.id);
    if (!uiSession || isReusableUiSession(uiSession, input.projectRoot)) {
      return {
        coreSession: reusableCoreSession,
        isNewSession: false,
        session: uiSession
          ? withCoreProjectRoot(uiSession, reusableCoreSession)
          : sessionMetadataToUiSession(reusableCoreSession),
      };
    }
  }

  for (const candidate of input.snapshot.sessions) {
    const resolved = await resolveReusableUiSession({
      projectRoot: input.projectRoot,
      session: candidate,
      sessionManager: input.sessionManager,
    });
    if (resolved) {
      return resolved;
    }
  }

  return {
    isNewSession: true,
    session: await input.createSession(),
  };
}
