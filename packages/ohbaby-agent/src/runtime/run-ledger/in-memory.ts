import { InvalidRunTransitionError, RunLedgerNotFoundError } from "./errors.js";
import type {
  CreatePendingRunLedgerInput,
  InMemoryRunLedgerOptions,
  ListRunLedgerOptions,
  MarkInterruptedOptions,
  MarkInterruptedResult,
  RunLedger,
  RunLedgerRecord,
  RunStatus,
} from "./types.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["pending", "running"]);
const INTERRUPTABLE_STATUSES = new Set<RunStatus>(["pending", "running"]);
const INTERRUPTED_REASON = "process interrupted before run completed";

function cloneRecord(record: RunLedgerRecord): RunLedgerRecord {
  return { ...record };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

function normalizeLimit(options?: ListRunLedgerOptions): number | undefined {
  if (options?.limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new RangeError(
      "Run ledger list limit must be a non-negative integer",
    );
  }

  return options.limit;
}

function validateInterruptibleStatuses(statuses: Iterable<RunStatus>): void {
  for (const status of statuses) {
    if (!INTERRUPTABLE_STATUSES.has(status)) {
      throw new InvalidRunTransitionError("bulk", status, "interrupted");
    }
  }
}

export class InMemoryRunLedger implements RunLedger {
  private readonly records = new Map<string, RunLedgerRecord>();
  private readonly now: () => number;

  constructor(options: InMemoryRunLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  createPending(input: CreatePendingRunLedgerInput): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() => {
      const existing = this.records.get(input.runId);
      if (existing) {
        throw new InvalidRunTransitionError(input.runId, undefined, "pending");
      }

      const record: RunLedgerRecord = {
        runId: input.runId,
        sessionId: input.sessionId,
        triggerSource: input.triggerSource,
        status: "pending",
        createdAt: this.now(),
      };
      this.records.set(input.runId, record);

      return cloneRecord(record);
    });
  }

  markRunning(runId: string): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() =>
      cloneRecord(
        this.transition(runId, "running", ["pending"], (record) => ({
          ...record,
          status: "running",
          startedAt: this.now(),
          endedAt: undefined,
          error: undefined,
        })),
      ),
    );
  }

  markSucceeded(runId: string): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() =>
      cloneRecord(
        this.transition(runId, "succeeded", ["running"], (record) => ({
          ...record,
          status: "succeeded",
          endedAt: this.now(),
          error: undefined,
        })),
      ),
    );
  }

  markFailed(runId: string, error: unknown): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() =>
      cloneRecord(
        this.transition(runId, "failed", ["pending", "running"], (record) => ({
          ...record,
          status: "failed",
          endedAt: this.now(),
          error: errorToMessage(error),
        })),
      ),
    );
  }

  markCancelled(runId: string, reason?: string): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() =>
      cloneRecord(
        this.transition(
          runId,
          "cancelled",
          ["pending", "running"],
          (record) => ({
            ...record,
            status: "cancelled",
            endedAt: this.now(),
            error: reason,
          }),
        ),
      ),
    );
  }

  markInterrupted(
    options: MarkInterruptedOptions = {},
  ): Promise<MarkInterruptedResult> {
    return this.withAsyncBoundary(() => {
      const statuses = new Set(options.statuses ?? INTERRUPTABLE_STATUSES);
      validateInterruptibleStatuses(statuses);
      const endedAt = this.now();
      let updatedCount = 0;

      for (const [runId, record] of this.records) {
        if (!statuses.has(record.status)) {
          continue;
        }

        this.records.set(runId, {
          ...record,
          status: "interrupted",
          endedAt,
          error: options.reason ?? INTERRUPTED_REASON,
        });
        updatedCount += 1;
      }

      return { updatedCount };
    });
  }

  get(runId: string): Promise<RunLedgerRecord | undefined> {
    return this.withAsyncBoundary(() => {
      const record = this.records.get(runId);
      return record ? cloneRecord(record) : undefined;
    });
  }

  listBySession(
    sessionId: string,
    options?: ListRunLedgerOptions,
  ): Promise<RunLedgerRecord[]> {
    return this.withAsyncBoundary(() => {
      const limit = normalizeLimit(options);
      const records = Array.from(this.records.values())
        .filter((record) => record.sessionId === sessionId)
        .sort((left, right) => right.createdAt - left.createdAt);

      return records.slice(0, limit).map(cloneRecord);
    });
  }

  getActiveRuns(sessionId?: string): Promise<RunLedgerRecord[]> {
    return this.withAsyncBoundary(() =>
      Array.from(this.records.values())
        .filter((record) => ACTIVE_STATUSES.has(record.status))
        .filter(
          (record) => sessionId === undefined || record.sessionId === sessionId,
        )
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(cloneRecord),
    );
  }

  private async withAsyncBoundary<T>(operation: () => T): Promise<T> {
    await Promise.resolve();
    return operation();
  }

  private transition(
    runId: string,
    toStatus: RunStatus,
    allowedFrom: readonly RunStatus[],
    update: (record: RunLedgerRecord) => RunLedgerRecord,
  ): RunLedgerRecord {
    const current = this.records.get(runId);
    if (!current) {
      throw new RunLedgerNotFoundError(runId);
    }
    if (!allowedFrom.includes(current.status)) {
      throw new InvalidRunTransitionError(runId, current.status, toStatus);
    }

    const next = update(current);
    this.records.set(runId, next);
    return next;
  }
}

export function createInMemoryRunLedger(
  options?: InMemoryRunLedgerOptions,
): RunLedger {
  return new InMemoryRunLedger(options);
}
