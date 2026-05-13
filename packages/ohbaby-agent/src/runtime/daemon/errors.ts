import type { DaemonPidRecord } from "./types.js";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly record?: DaemonPidRecord) {
    super(
      record
        ? `ohbaby-agent daemon is already running with pid ${String(record.pid)}`
        : "ohbaby-agent daemon is already running",
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

export class DaemonBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonBootstrapError";
  }
}
