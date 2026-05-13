import type { RunStatus } from "./types.js";

export class RunLedgerNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ledger record not found: ${runId}`);
    this.name = "RunLedgerNotFoundError";
  }
}

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly runId: string,
    readonly fromStatus: RunStatus | undefined,
    readonly toStatus: RunStatus,
  ) {
    super(
      fromStatus === undefined
        ? `Cannot create duplicate run ledger record: ${runId}`
        : `Cannot transition run ${runId} from ${fromStatus} to ${toStatus}`,
    );
    this.name = "InvalidRunTransitionError";
  }
}
