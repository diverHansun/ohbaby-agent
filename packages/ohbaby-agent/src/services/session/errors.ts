import { FORK_TARGET_INVALID_ERROR_CODE } from "ohbaby-sdk";

export class SideChatUnsupportedError extends Error {
  readonly code = "SIDE_CHAT_UNSUPPORTED";

  constructor(message = "This operation is unavailable in side chat.") {
    super(message);
    this.name = "SideChatUnsupportedError";
  }
}

export class ForkTargetInvalidError extends Error {
  readonly code = FORK_TARGET_INVALID_ERROR_CODE;

  constructor() {
    super("No completed main turn with an AI answer to fork from.");
    this.name = "ForkTargetInvalidError";
  }
}

/** The requested run cannot serve as a history-copy cut. */
export class HistoryCutInvalidError extends Error {
  constructor(
    readonly sessionId: string,
    readonly runId: string,
  ) {
    super(`No ended main turn with messages: ${runId}`);
    this.name = "HistoryCutInvalidError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class DuplicateSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "DuplicateSessionError";
  }
}

/** The session's next turn belongs to another workspace directory. */
export class SessionMovedError extends Error {
  readonly code = "SESSION_MOVED";

  constructor(
    readonly sessionId: string,
    readonly targetDirectory: string,
  ) {
    super("Session belongs to another workspace");
    this.name = "SessionMovedError";
  }
}

export class InvalidSessionLimitError extends RangeError {
  constructor() {
    super("Session list limit must be a non-negative integer");
    this.name = "InvalidSessionLimitError";
  }
}

export class InvalidSessionStatsDeltaError extends RangeError {
  constructor() {
    super("Session message count delta must keep messageCount non-negative");
    this.name = "InvalidSessionStatsDeltaError";
  }
}

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
