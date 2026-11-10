import type { UiForkSessionInput, UiRewindSessionInput } from "./client.js";

/** Cross-workspace session catalog served by the daemon's global routes. */

/** The next turn of a moved session must run in `targetDirectory`. */
export const SESSION_MOVED_ERROR_CODE = "SESSION_MOVED";

export const FORK_TARGET_INVALID_ERROR_CODE = "FORK_TARGET_INVALID";

export const REWIND_TARGET_INVALID_ERROR_CODE = "REWIND_TARGET_INVALID";
export const REWIND_BEFORE_COMPACTION_ERROR_CODE = "REWIND_BEFORE_COMPACTION";

function invalidSessionInput(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** REST supplies the source in its path. RPC and in-process calls include it in the input. */
function parseSessionCommand(
  value: unknown,
  pathSessionId: string | undefined,
  fields: readonly string[],
  code: string,
): { sessionId: string; body: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidSessionInput(code, "Session command input must be an object");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (
      !fields.includes(key) &&
      !(key === "sessionId" && pathSessionId === undefined)
    )
      return invalidSessionInput(code, `Unknown session command field: ${key}`);
  }
  const sessionId = pathSessionId ?? body.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim())
    return invalidSessionInput(code, "sessionId must be a nonempty string");
  return { sessionId, body };
}

export function parseForkSessionInput(
  value: unknown,
  pathSessionId?: string,
): UiForkSessionInput {
  const { sessionId, body } = parseSessionCommand(
    value,
    pathSessionId,
    ["runId"],
    FORK_TARGET_INVALID_ERROR_CODE,
  );
  if (body.runId === undefined) return { sessionId };
  if (typeof body.runId !== "string" || !body.runId.trim())
    return invalidSessionInput(
      FORK_TARGET_INVALID_ERROR_CODE,
      "runId must be a nonempty string",
    );
  return { sessionId, runId: body.runId };
}

export function parseRewindSessionInput(
  value: unknown,
  pathSessionId?: string,
): UiRewindSessionInput {
  const { sessionId, body } = parseSessionCommand(
    value,
    pathSessionId,
    ["promptId", "text"],
    REWIND_TARGET_INVALID_ERROR_CODE,
  );
  if (typeof body.promptId !== "string" || !body.promptId.trim())
    return invalidSessionInput(
      REWIND_TARGET_INVALID_ERROR_CODE,
      "promptId must be a nonempty string",
    );
  if (body.text === undefined) return { sessionId, promptId: body.promptId };
  if (typeof body.text !== "string" || !body.text.trim())
    return invalidSessionInput(
      REWIND_TARGET_INVALID_ERROR_CODE,
      "text must be a nonempty string",
    );
  return { sessionId, promptId: body.promptId, text: body.text };
}

export const SIDE_CHAT_UNSUPPORTED_ERROR_CODE = "SIDE_CHAT_UNSUPPORTED";
export const SESSION_RUNNING_ERROR_CODE = "SESSION_RUNNING";
export const SESSION_NOT_ARCHIVED_ERROR_CODE = "SESSION_NOT_ARCHIVED";
export type UiGlobalSessionStatus = "active" | "archived";
export interface UiSessionDeleteResult {
  readonly deletedSessionIds: readonly string[];
}

export interface UiDefaultDirectory {
  /** Real working directory for sessions started without a workspace. */
  readonly directory: string;
}

export interface UiGlobalSession {
  readonly isSideChat?: boolean;
  readonly id: string;
  readonly title: string;
  readonly status: UiGlobalSessionStatus;
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
