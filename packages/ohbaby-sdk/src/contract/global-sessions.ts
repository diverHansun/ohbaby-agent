/** Cross-workspace session catalog served by the daemon's global routes. */

/** The next turn of a moved session must run in `targetDirectory`. */
export const SESSION_MOVED_ERROR_CODE = "SESSION_MOVED";

export interface UiDefaultDirectory {
  /** Real working directory for sessions started without a workspace. */
  readonly directory: string;
}

export interface UiGlobalSession {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  /** Sidebar workspace; null means the session has no workspace. */
  readonly workspaceDirectory: string | null;
  /** Directory of the current or most recent turn. */
  readonly workingDirectory: string;
  /** Directory of the next turn after a workspace change. */
  readonly pendingWorkingDirectory?: string;
}

export interface UiGlobalSessionPage {
  readonly sessions: readonly UiGlobalSession[];
  readonly nextCursor?: string;
}

export type UiSessionSearchMatchType = "title" | "message";

export interface UiSessionSearchResult {
  readonly session: UiGlobalSession;
  readonly matchType: UiSessionSearchMatchType;
  readonly snippet: string;
  readonly messageId?: string;
}

export interface UiSessionSearchPage {
  readonly results: readonly UiSessionSearchResult[];
  readonly nextCursor?: string;
}

/** A directory selects a workspace; null removes the session from its workspace. */
export interface UiSessionWorkspaceUpdate {
  readonly workspaceDirectory: string | null;
}

/** Directory a client should send the session's next request to. */
export function globalSessionRequestDirectory(
  session: UiGlobalSession,
): string {
  return session.pendingWorkingDirectory ?? session.workingDirectory;
}
