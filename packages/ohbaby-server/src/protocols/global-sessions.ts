import type {
  UiGlobalSession,
  UiGlobalSessionStatus,
  UiGlobalSessionPage,
  UiSessionSearchPage,
} from "ohbaby-sdk";
import type {
  CoreSession,
  GlobalSessionPage,
  SessionSearchPage,
} from "ohbaby-agent";

/** Wire format of the daemon's global session routes. */

export function toUiGlobalSession(session: CoreSession): UiGlobalSession {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    messageCount: session.stats.messageCount,
    workspaceDirectory: session.workspaceDirectory ?? null,
    workingDirectory: session.workingDirectory,
    ...(session.pendingWorkingDirectory === undefined
      ? {}
      : { pendingWorkingDirectory: session.pendingWorkingDirectory }),
  };
}

export function toUiGlobalSessionPage(
  page: GlobalSessionPage,
): UiGlobalSessionPage {
  return {
    sessions: page.sessions.map(toUiGlobalSession),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export function toUiSessionSearchPage(
  page: SessionSearchPage,
): UiSessionSearchPage {
  return {
    results: page.hits.map((hit) => ({
      session: toUiGlobalSession(hit.session),
      matchType: hit.matchType,
      snippet: hit.snippet,
      ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }),
    })),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

function invalid(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Absent means the default page size; anything else must be a positive integer. */
export function parseGlobalSessionLimit(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw invalid("INVALID_QUERY", "limit must be a positive integer");
  }
  return parsed;
}

export function parseGlobalSessionStatus(
  value: string | undefined,
): UiGlobalSessionStatus {
  if (value === undefined) return "active";
  if (value === "active" || value === "archived") return value;
  throw invalid("INVALID_QUERY", "status must be active or archived");
}

/** A directory selects a workspace; an explicit null leaves the current one. */
export function parseSessionWorkspaceUpdate(body: unknown): string | null {
  const requested =
    typeof body === "object" && body !== null && "workspaceDirectory" in body
      ? body.workspaceDirectory
      : undefined;
  if (requested === null) return null;
  if (typeof requested !== "string" || requested.length === 0) {
    throw invalid(
      "INVALID_DIRECTORY",
      "workspaceDirectory must be a directory path or null",
    );
  }
  return requested;
}

export function globalSessionErrorStatus(
  error: unknown,
): 400 | 404 | 409 | 500 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  switch (code) {
    case "INVALID_QUERY":
    case "INVALID_CURSOR":
    case "INVALID_DIRECTORY":
    case "DEFAULT_DIRECTORY_NOT_WORKSPACE":
    case "directory-required":
    case "directory-must-be-absolute":
    case "directory-unavailable":
    case "directory-not-directory":
      return 400;
    case "SESSION_NOT_FOUND":
      return 404;
    case "SESSION_NOT_ROOT":
    case "SESSION_ARCHIVED":
    case "SESSION_NOT_ARCHIVED":
    case "SESSION_RUNNING":
      return 409;
    default:
      return 500;
  }
}
