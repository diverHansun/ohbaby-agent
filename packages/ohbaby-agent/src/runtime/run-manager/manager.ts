import type { RunLedgerRecord } from "../run-ledger/index.js";
import { ConcurrencyRejectedError, RunManagerNotFoundError } from "./errors.js";
import { mergeRunDefaults } from "./policy.js";
import type {
  CreateRunOptions,
  ManagedRunRecord,
  RunCompletion,
  RunContext,
  RunManagerDeps,
  RunRecord,
  RunStatus,
  RunWorkerResult,
  SandboxLease,
} from "./types.js";
import { RunWorker } from "./worker.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["pending", "running"]);
const DEFAULT_SANDBOX_MANAGER = {
  acquire(sessionId: string): Promise<SandboxLease> {
    return Promise.resolve({ id: `local_${sessionId}` });
  },
  release(): Promise<void> {
    return Promise.resolve();
  },
};

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createDefaultRunId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `run_${Date.now().toString(36)}_${random}`;
}

function cloneRunRecord(record: RunRecord): RunRecord {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    triggerSource: record.triggerSource,
    status: record.status,
    permissionProfileId: record.permissionProfileId,
    multitaskStrategy: record.multitaskStrategy,
    disconnectMode: record.disconnectMode,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    error: record.error,
  };
}

function serializableRun(record: RunRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(cloneRunRecord(record)).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

function isActive(record: RunRecord): boolean {
  return ACTIVE_STATUSES.has(record.status);
}

function completionFromResult(result: RunWorkerResult): RunCompletion {
  if (result.status === "succeeded") {
    return { status: "succeeded" };
  }

  return {
    status: result.status,
    error: result.error,
  };
}

export class RunManager {
  private readonly recordsById = new Map<string, ManagedRunRecord>();
  private readonly activeBySession = new Map<string, Set<string>>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly createRunId: () => string;

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.createRunId = deps.createRunId ?? createDefaultRunId;
  }

  async init(): Promise<{ readonly updatedCount: number }> {
    this.recordsById.clear();
    this.activeBySession.clear();
    return this.deps.runLedger.markInterrupted({
      statuses: ["pending", "running"],
    });
  }

  async create(options: CreateRunOptions): Promise<RunRecord> {
    return this.withSessionLock(options.sessionId, async () => {
      const resolved = mergeRunDefaults(
        this.deps.policy,
        options.triggerSource,
        options.explicit,
      );
      const activeRunIds = this.activeRunIds(options.sessionId);
      if (activeRunIds.length > 0) {
        if (resolved.multitaskStrategy !== "interrupt-current") {
          throw new ConcurrencyRejectedError(options.sessionId, activeRunIds);
        }
        await this.interruptActiveRuns(activeRunIds);
      }

      const runId = options.runId ?? this.createRunId();
      await this.deps.runLedger.createPending({
        runId,
        sessionId: options.sessionId,
        triggerSource: options.triggerSource,
      });

      const record: ManagedRunRecord = {
        runId,
        sessionId: options.sessionId,
        triggerSource: options.triggerSource,
        status: "pending",
        permissionProfileId: resolved.permissionProfileId,
        multitaskStrategy: resolved.multitaskStrategy,
        disconnectMode: resolved.disconnectMode,
        createdAt: this.now(),
        abortController: new AbortController(),
        options,
      };
      this.recordsById.set(runId, record);
      this.addActive(record);
      this.publishRunUpdated(record);

      record.completion = this.startRun(record);

      return cloneRunRecord(record);
    });
  }

  cancel(runId: string, reason = "run cancelled"): void {
    const record = this.recordsById.get(runId);
    if (!record) {
      throw new RunManagerNotFoundError(runId);
    }
    if (!isActive(record)) {
      return;
    }

    record.cancelReason = reason;
    record.abortController.abort(reason);
  }

  async cancelAll(reason = "run manager shutting down"): Promise<void> {
    const activeRecords = Array.from(this.recordsById.values()).filter(
      isActive,
    );
    for (const record of activeRecords) {
      this.cancel(record.runId, reason);
    }
    const completions = activeRecords
      .map((record) => record.completion)
      .filter(
        (completion): completion is Promise<RunCompletion> =>
          completion !== undefined,
      );
    await Promise.all(completions);
  }

  get(runId: string): RunRecord | undefined {
    const record = this.recordsById.get(runId);
    return record ? cloneRunRecord(record) : undefined;
  }

  list(sessionId: string): RunRecord[] {
    return this.activeRunIds(sessionId)
      .map((runId) => this.recordsById.get(runId))
      .filter((record): record is ManagedRunRecord => record !== undefined)
      .map(cloneRunRecord);
  }

  waitForCompletion(runId: string): Promise<RunCompletion> {
    const record = this.recordsById.get(runId);
    if (!record?.completion) {
      return Promise.reject(new RunManagerNotFoundError(runId));
    }

    return record.completion;
  }

  private async startRun(record: ManagedRunRecord): Promise<RunCompletion> {
    const sandboxManager = this.deps.sandboxManager ?? DEFAULT_SANDBOX_MANAGER;
    let outcome: RunWorkerResult;

    try {
      const sandboxLease = await sandboxManager.acquire(record.sessionId);
      record.sandboxLease = sandboxLease;
      const context: RunContext = {
        runId: record.runId,
        sessionId: record.sessionId,
        triggerSource: record.triggerSource,
        permissionProfileId: record.permissionProfileId,
        sandboxLease,
        abortSignal: record.abortController.signal,
        agent: record.options.agent,
        isSubagent: record.options.isSubagent,
        parentMessageId: record.options.parentMessageId,
        maxSteps: record.options.maxSteps,
        messages: record.options.messages,
        directory: record.options.directory,
        modelId: record.options.modelId,
        tools: record.options.tools,
      };
      const worker = new RunWorker(context, {
        lifecycle: this.deps.lifecycle,
        streamBridge: this.deps.streamBridge,
        hookExecutor: this.deps.hookExecutor,
      });

      outcome = await worker.start({
        run: cloneRunRecord(record),
        onRunning: async () => {
          const ledgerRecord = await this.deps.runLedger.markRunning(
            record.runId,
          );
          this.applyLedgerProjection(record, ledgerRecord);
          this.publishRunUpdated(record);
        },
      });
    } catch (error) {
      outcome = {
        status: record.abortController.signal.aborted ? "cancelled" : "failed",
        error: record.abortController.signal.aborted
          ? (record.cancelReason ?? "run cancelled")
          : errorToMessage(error),
      };
    }

    return this.finalizeRun(record, outcome);
  }

  private async finalizeRun(
    record: ManagedRunRecord,
    outcome: RunWorkerResult,
  ): Promise<RunCompletion> {
    const sandboxManager = this.deps.sandboxManager ?? DEFAULT_SANDBOX_MANAGER;
    const completion = completionFromResult(outcome);

    try {
      const ledgerRecord = await this.markLedgerTerminal(record, outcome);
      this.applyLedgerProjection(record, ledgerRecord);
    } catch (error) {
      record.status = outcome.status;
      record.endedAt = this.now();
      record.error = outcome.error ?? errorToMessage(error);
    } finally {
      this.removeActive(record);
      if (record.sandboxLease) {
        try {
          await sandboxManager.release(record.sandboxLease);
        } catch {
          // Resource cleanup must not break the run completion contract.
        }
      }
      this.publishRunUpdated(record);
      this.endStream(record);
    }

    return completion;
  }

  private markLedgerTerminal(
    record: ManagedRunRecord,
    outcome: RunWorkerResult,
  ): Promise<RunLedgerRecord> {
    if (outcome.status === "succeeded") {
      return this.deps.runLedger.markSucceeded(record.runId);
    }
    if (outcome.status === "cancelled") {
      return this.deps.runLedger.markCancelled(
        record.runId,
        outcome.error ?? record.cancelReason,
      );
    }

    return this.deps.runLedger.markFailed(
      record.runId,
      outcome.error ?? "run failed",
    );
  }

  private applyLedgerProjection(
    record: ManagedRunRecord,
    ledgerRecord: RunLedgerRecord,
  ): void {
    record.status = ledgerRecord.status;
    record.startedAt = ledgerRecord.startedAt;
    record.endedAt = ledgerRecord.endedAt;
    record.error = ledgerRecord.error;
  }

  private publishRunUpdated(record: RunRecord): void {
    try {
      this.deps.streamBridge.publish(`run/${record.runId}`, "run.updated", {
        run: serializableRun(record),
      });
    } catch {
      // Stream observers are best-effort; run control state remains authoritative.
    }
  }

  private endStream(record: RunRecord): void {
    try {
      this.deps.streamBridge.end(`run/${record.runId}`);
    } catch {
      // Stream cleanup must not reject waitForCompletion().
    }
  }

  private async interruptActiveRuns(runIds: readonly string[]): Promise<void> {
    const completions: Promise<RunCompletion>[] = [];

    for (const runId of runIds) {
      const record = this.recordsById.get(runId);
      if (!record?.completion || !isActive(record)) {
        continue;
      }

      this.cancel(runId, "interrupted by replacement run");
      completions.push(record.completion);
    }

    await Promise.all(completions);
  }

  private addActive(record: RunRecord): void {
    const runIds = this.activeBySession.get(record.sessionId) ?? new Set();
    runIds.add(record.runId);
    this.activeBySession.set(record.sessionId, runIds);
  }

  private removeActive(record: RunRecord): void {
    const runIds = this.activeBySession.get(record.sessionId);
    if (!runIds) {
      return;
    }

    runIds.delete(record.runId);
    if (runIds.size === 0) {
      this.activeBySession.delete(record.sessionId);
    }
  }

  private activeRunIds(sessionId: string): string[] {
    const runIds = Array.from(this.activeBySession.get(sessionId) ?? []);
    return runIds.filter((runId) => {
      const record = this.recordsById.get(runId);
      return record ? isActive(record) : false;
    });
  }

  private async withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.sessionLocks.set(sessionId, chain);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === chain) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }
}
