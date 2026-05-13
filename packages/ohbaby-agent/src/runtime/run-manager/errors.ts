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
