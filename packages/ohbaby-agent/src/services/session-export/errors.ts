export type SessionExportErrorCode =
  | "INVALID_FORMAT"
  | "INVALID_ARGUMENT"
  | "SESSION_NOT_FOUND"
  | "SUBAGENT_SESSION"
  | "EMPTY_SESSION";

export class SessionExportError extends Error {
  override readonly name = "SessionExportError";
  constructor(
    readonly code: SessionExportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
