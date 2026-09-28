import type { TriggerSource } from "../run-ledger/index.js";

export class ConcurrencyRejectedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly activeRunIds: readonly string[],
  ) {
    super(
      `Session ${sessionId} already has active runs: ${activeRunIds.join(", ")}`,
    );
    this.name = "ConcurrencyRejectedError";
  }
}

export class RunManagerNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunManagerNotFoundError";
  }
}

export class RunDefaultsPolicyError extends Error {
  constructor(readonly triggerSource: TriggerSource) {
    super(`Run defaults policy is missing trigger source: ${triggerSource}`);
    this.name = "RunDefaultsPolicyError";
  }
}

export class RunFinalizationError extends Error {
  constructor(
    readonly runId: string,
    readonly stage:
      | "input-closure"
      | "permissions"
      | "execution-history"
      | "run-terminal",
    cause: unknown,
  ) {
    super(
      `Run ${runId} could not persist ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RunFinalizationError";
  }
}
