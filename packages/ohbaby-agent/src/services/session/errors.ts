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
