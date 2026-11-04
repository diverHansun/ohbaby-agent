export class TerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 | 503,
    readonly process?: string,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}
