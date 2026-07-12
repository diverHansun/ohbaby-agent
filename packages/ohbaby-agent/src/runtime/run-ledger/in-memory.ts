import {
  InvalidRunTransitionError,
  RunLedgerNotFoundError,
  SessionRunBusyError,
} from "./errors.js";
import type {
  ClaimPendingRunLedgerInput,
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
const ORPHANED_OWNER_REASON = "process interrupted before owner exited";

function cloneRecord(record: RunLedgerRecord): RunLedgerRecord {
  return { ...record };
}

function sameActiveScope(
  record: RunLedgerRecord,
  input: ClaimPendingRunLedgerInput,
): boolean {
  return (
    record.sessionId === input.sessionId &&
    record.contextScopeId === input.contextScopeId
  );
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
  private readonly isOwnerAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly ownerId?: string;
  private readonly ownerPid?: number;

  constructor(options: InMemoryRunLedgerOptions = {}) {
    this.isOwnerAlive = options.isOwnerAlive ?? ((): boolean => true);
    this.now = options.now ?? Date.now;
    this.ownerId = options.ownerId;
    this.ownerPid = options.ownerPid;
  }

  createPending(input: CreatePendingRunLedgerInput): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() => {
      return cloneRecord(this.createPendingSync(input));
    });
  }

  claimPendingRun(input: ClaimPendingRunLedgerInput): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() => {
      const activeRecords = Array.from(this.records.values())
        .filter((record) => sameActiveScope(record, input))
        .filter((record) => ACTIVE_STATUSES.has(record.status));
      const activeRunIds = activeRecords
        .filter((record) => !this.recoverIfOrphaned(record, false))
        .map((record) => record.runId);
      if (activeRunIds.length > 0) {
        throw new SessionRunBusyError(input.sessionId, activeRunIds);
      }
      return cloneRecord(this.createPendingSync(input));
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
          errorData: undefined,
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
          errorData: undefined,
        })),
      ),
    );
  }

  markFailed(
    runId: string,
    error: unknown,
    errorData?: RunLedgerRecord["errorData"],
  ): Promise<RunLedgerRecord> {
    return this.withAsyncBoundary(() =>
      cloneRecord(
        this.transition(runId, "failed", ["pending", "running"], (record) => ({
          ...record,
          status: "failed",
          endedAt: this.now(),
          error: errorToMessage(error),
          errorData,
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
            errorData: undefined,
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

  recoverOrphanedRuns(): Promise<MarkInterruptedResult> {
    return this.withAsyncBoundary(() => {
      let updatedCount = 0;
      for (const record of this.records.values()) {
        if (this.recoverIfOrphaned(record, true)) {
          updatedCount += 1;
        }
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

  private createPendingSync(
    input: CreatePendingRunLedgerInput,
  ): RunLedgerRecord {
    const existing = this.records.get(input.runId);
    if (existing) {
      throw new InvalidRunTransitionError(input.runId, undefined, "pending");
    }

    const ownerId = input.ownerId ?? this.ownerId;
    const ownerPid = input.ownerPid ?? this.ownerPid;
    const record: RunLedgerRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId,
      triggerSource: input.triggerSource,
      status: "pending",
      createdAt: this.now(),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(ownerPid === undefined ? {} : { ownerPid }),
    };
    this.records.set(input.runId, record);

    return record;
  }

  private isOrphaned(
    record: RunLedgerRecord,
    recoverUnknownOwner: boolean,
  ): boolean {
    if (!ACTIVE_STATUSES.has(record.status)) {
      return false;
    }
    if (record.ownerPid === undefined) {
      return recoverUnknownOwner;
    }
    return !this.isOwnerAlive(record.ownerPid);
  }

  private recoverIfOrphaned(
    record: RunLedgerRecord,
    recoverUnknownOwner: boolean,
  ): boolean {
    if (!this.isOrphaned(record, recoverUnknownOwner)) {
      return false;
    }
    this.records.set(record.runId, {
      ...record,
      status: "interrupted",
      endedAt: this.now(),
      error: ORPHANED_OWNER_REASON,
    });
    return true;
  }
}

export function createInMemoryRunLedger(
  options?: InMemoryRunLedgerOptions,
): RunLedger {
  return new InMemoryRunLedger(options);
}
