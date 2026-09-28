import {
  mergeReasoningIntent,
  type ReasoningIntent,
} from "../../services/interface-providers/reasoning.js";
import type { RunLedgerRecord } from "../run-ledger/index.js";
import { scopedSessionKey } from "../../utils/scoped-session.js";
import {
  ConcurrencyRejectedError,
  RunManagerNotFoundError,
  RunFinalizationError,
} from "./errors.js";
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
} from "./types.js";
import { RunWorker } from "./worker.js";
import { normalizeRunError } from "./error-detail.js";
import {
  createDatabaseWriteBudget,
  getDatabaseWriteBudget,
  withDatabaseWriteBudget,
} from "../../services/database/write-budget.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["pending", "running"]);

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
    errorData: record.errorData,
    terminalReason: record.terminalReason,
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
  const terminalReason = result.terminalReason ?? result.result?.terminalReason;
  const usage = result.result?.usage;
  if (result.status === "succeeded") {
    return {
      status: "succeeded",
      ...(result.result === undefined
        ? {}
        : { finalResponse: result.result.finalResponse }),
      ...(terminalReason === undefined ? {} : { terminalReason }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  return {
    status: result.status,
    error: result.error,
    ...(result.errorData === undefined ? {} : { errorData: result.errorData }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

export class RunManager {
  private readonly recordsById = new Map<string, ManagedRunRecord>();
  private readonly activeBySession = new Map<string, Set<string>>();
  private readonly pendingSandboxReleases = new Set<Promise<void>>();
  private readonly failedSandboxReleases: unknown[] = [];
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly createRunId: () => string;

  constructor(private readonly deps: RunManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.createRunId = deps.createRunId ?? createDefaultRunId;
  }

  async init(): Promise<{ readonly updatedCount: number }> {
    const active = Array.from(this.recordsById.values()).find(isActive);
    if (active)
      throw new ConcurrencyRejectedError(active.sessionId, [active.runId]);
    return this.deps.runLedger.recoverOrphanedRuns();
  }

  async create(options: CreateRunOptions): Promise<RunRecord> {
    options = {
      ...options,
      ...(options.reasoning === undefined
        ? {}
        : { reasoning: mergeReasoningIntent(options.reasoning) }),
    };
    const lockKey = scopedSessionKey({
      contextScopeId: options.contextScopeId,
      sessionId: options.sessionId,
    });
    return this.withSessionLock(lockKey, async () => {
      const resolved = mergeRunDefaults(
        this.deps.policy,
        options.triggerSource,
        options.explicit,
      );
      const activeRunIds = this.activeRunIds({
        contextScopeId: options.contextScopeId,
        sessionId: options.sessionId,
      });
      if (activeRunIds.length > 0) {
        if (resolved.multitaskStrategy !== "interrupt-current") {
          throw new ConcurrencyRejectedError(options.sessionId, activeRunIds);
        }
        await this.interruptActiveRuns(activeRunIds);
      }

      const runId = options.runId ?? this.createRunId();
      const ledgerRecord = await this.deps.runLedger.claimPendingRun({
        contextScopeId: options.contextScopeId,
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
        createdAt: ledgerRecord.createdAt,
        abortController: new AbortController(),
        options,
      };
      this.recordsById.set(runId, record);
      this.addActive(record);
      this.publishRunUpdated(record);

      record.completion = this.startRun(record);
      // Creation is fire-and-forget; callers observe failures through wait/retry.
      void record.completion.catch(() => undefined);

      return cloneRunRecord(record);
    });
  }

  fail(runId: string, error: Error): void {
    const record = this.recordsById.get(runId);
    if (
      !record ||
      !isActive(record) ||
      record.finalization ||
      record.abortController.signal.aborted
    )
      return;
    record.fatalError = error;
    this.closeInputs(record, error.message);
    try {
      this.revokePermissionsForRun(runId, error.message);
    } finally {
      record.abortController.abort(error);
    }
  }

  cancel(runId: string, reason = "run cancelled"): void {
    this.cancelRun(
      runId,
      reason,
      reason === "subagent closed" || reason === "session removed"
        ? "cancelled"
        : "interrupted",
    );
  }

  private cancelRun(
    runId: string,
    reason: string,
    status: "cancelled" | "interrupted",
  ): void {
    const record = this.recordsById.get(runId);
    if (!record) {
      throw new RunManagerNotFoundError(runId);
    }
    if (
      !isActive(record) ||
      record.finalization ||
      record.abortController.signal.aborted
    ) {
      return;
    }

    record.cancelReason = reason;
    record.cancelStatus = status;
    this.closeInputs(record, reason);
    try {
      this.revokePermissionsForRun(runId, reason);
    } finally {
      record.abortController.abort(reason);
    }
  }

  private closeInputs(record: ManagedRunRecord, reason: string): void {
    const inputs = this.deps.currentRunInputs;
    if (record.inputClosure || !inputs) return;
    record.inputCloseReason ??= reason;
    try {
      // close() seals its synchronous gate before returning its durable promise.
      record.inputClosure = this.withFinalizationWriteBudget(record.runId, () =>
        inputs.close(record.runId, record.inputCloseReason ?? reason),
      );
    } catch (error) {
      record.inputClosure = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    void record.inputClosure.catch(() => undefined);
  }

  async waitForInputClosure(runId: string): Promise<void> {
    await this.recordsById.get(runId)?.inputClosure;
  }

  revokePermissionsForRun(runId: string, reason: string): void {
    this.deps.revokePermissionsForRun?.(runId, reason);
  }

  hasActiveWork(): boolean {
    return (
      this.activeBySession.size > 0 ||
      this.pendingSandboxReleases.size > 0 ||
      this.failedSandboxReleases.length > 0
    );
  }

  async waitForCleanup(): Promise<void> {
    await Promise.allSettled([...this.pendingSandboxReleases]);
    if (this.failedSandboxReleases.length) {
      throw new AggregateError(
        this.failedSandboxReleases,
        `Sandbox release remains unconfirmed: ${this.failedSandboxReleases.map(errorToMessage).join("; ")}`,
      );
    }
  }

  async cancelAll(reason = "run manager shutting down"): Promise<void> {
    const activeRecords = Array.from(this.recordsById.values()).filter(
      isActive,
    );
    for (const record of activeRecords) {
      try {
        this.cancel(record.runId, reason);
      } catch {
        // Signal delivery is in finally; one failed revocation must not prevent
        // stopping the other runs. Finalization reports/retries that failure.
      }
    }
    const completions = activeRecords
      .map((record) =>
        record.finalizationError
          ? this.retryFinalization(record.runId)
          : record.completion,
      )
      .filter(
        (completion): completion is Promise<RunCompletion> =>
          completion !== undefined,
      );
    try {
      await Promise.all(completions);
    } finally {
      await this.waitForCleanup();
    }
  }

  getActiveReasoning(
    sessionId: string,
    contextScopeId?: string,
  ): ReasoningIntent | undefined {
    const runId = this.activeRunIds({ sessionId, contextScopeId }).at(0);
    const reasoning =
      runId === undefined
        ? undefined
        : this.recordsById.get(runId)?.options.reasoning;
    return reasoning === undefined
      ? undefined
      : mergeReasoningIntent(reasoning);
  }

  get(runId: string): RunRecord | undefined {
    const record = this.recordsById.get(runId);
    return record ? cloneRunRecord(record) : undefined;
  }

  list(sessionId: string): RunRecord[] {
    return Array.from(this.recordsById.values())
      .filter((record) => record.sessionId === sessionId && isActive(record))
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
    const sandboxManager = this.deps.sandboxManager;
    let outcome: RunWorkerResult;

    try {
      const sandboxLease = await sandboxManager.acquire({
        contextScopeId: record.options.contextScopeId,
        sessionId: record.sessionId,
        workdir: record.options.directory,
      });
      record.sandboxLease = sandboxLease;
      const context: RunContext = {
        agentInstanceId: record.options.agentInstanceId,
        runId: record.runId,
        sessionId: record.sessionId,
        contextScopeId: record.options.contextScopeId,
        triggerSource: record.triggerSource,
        permissionProfileId: record.permissionProfileId,
        sandboxLease,
        abortSignal: record.abortController.signal,
        agent: record.options.agent,
        directory: record.options.directory,
        isSubagent: record.options.isSubagent,
        initiatingUserMessageId: record.options.initiatingUserMessageId,
        maxSteps: record.options.maxSteps,
        modelId: record.options.modelId,
        ...(record.options.reasoning === undefined
          ? {}
          : { reasoning: mergeReasoningIntent(record.options.reasoning) }),
        parentMessageId: record.options.parentMessageId,
        tools: record.options.tools,
      };
      const worker = new RunWorker(context, {
        currentRunInputs: this.deps.createCurrentRunInputPort?.(context),
        getFatalError: (): Error | undefined => record.fatalError,
        lifecycle: this.deps.lifecycle,
        streamBridge: this.deps.streamBridge,
        hookExecutor: this.deps.hookExecutor,
        onStepUsage: this.deps.onStepUsage,
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
      if (record.abortController.signal.aborted) {
        outcome = {
          ...outcome,
          status: record.cancelStatus ?? "cancelled",
          error: record.cancelReason ?? "run cancelled",
          terminalReason: "cancelled",
        };
      }
    } catch (error) {
      outcome = {
        status: record.abortController.signal.aborted
          ? (record.cancelStatus ?? "cancelled")
          : "failed",
        error: record.abortController.signal.aborted
          ? (record.cancelReason ?? "run cancelled")
          : errorToMessage(error),
        ...(record.abortController.signal.aborted
          ? {}
          : { errorData: normalizeRunError(error) }),
      };
    }

    if (record.fatalError) {
      outcome = {
        ...outcome,
        status: "failed",
        error: record.fatalError.message,
        errorData: normalizeRunError(record.fatalError),
        terminalReason: "tool_persistence_failure",
      };
    }
    record.finalization = { outcome, endedAt: this.now() };
    // Raw tool operations retain their own sandbox operation lease. Releasing
    // this logical run lease must neither wait for them nor destroy the context.
    if (record.sandboxLease) {
      try {
        record.sandboxRelease = this.deps.sandboxManager.release(
          record.sandboxLease,
        );
        const release = record.sandboxRelease;
        this.pendingSandboxReleases.add(release);
        void release.then(
          () => {
            this.pendingSandboxReleases.delete(release);
          },
          (error: unknown) => {
            this.pendingSandboxReleases.delete(release);
            this.failedSandboxReleases.push(error);
          },
        );
      } catch (error) {
        this.failedSandboxReleases.push(error);
      }
    }
    return this.retryFinalization(record.runId);
  }

  retryFinalization(runId: string): Promise<RunCompletion> {
    const record = this.recordsById.get(runId);
    if (!record) return Promise.reject(new RunManagerNotFoundError(runId));
    if (!record.finalization || !isActive(record))
      return this.waitForCompletion(runId);
    if (record.finalizationAttempt) return record.finalizationAttempt;
    if (record.finalizationError?.stage === "input-closure")
      record.inputClosure = undefined;
    const outcome = record.finalization.outcome;
    const attempt = this.withFinalizationWriteBudget(
      runId,
      () => this.finalizeRun(record, outcome),
      { retry: record.finalizationError !== undefined },
    );
    record.finalizationAttempt = attempt;
    record.completion = attempt;
    void attempt.then(
      () => {
        record.finalizationAttempt = undefined;
        record.finalizationError = undefined;
      },
      (error: unknown) => {
        record.finalizationAttempt = undefined;
        if (error instanceof RunFinalizationError)
          record.finalizationError = error;
      },
    );
    return attempt;
  }

  /** Also wraps tree input closure and the prompt save following this Run. */
  withFinalizationWriteBudget<T>(
    runId: string,
    operation: () => T,
    options?: { readonly retry?: boolean },
  ): T {
    const record = this.recordsById.get(runId);
    const inherited = getDatabaseWriteBudget();
    const budget =
      inherited ??
      (options?.retry ? undefined : record?.finalizationWriteBudget) ??
      createDatabaseWriteBudget();
    if (record) record.finalizationWriteBudget = budget;
    return withDatabaseWriteBudget(budget, operation);
  }

  private async finalizeRun(
    record: ManagedRunRecord,
    outcome: RunWorkerResult,
  ): Promise<RunCompletion> {
    this.closeInputs(
      record,
      outcome.terminalReason ?? outcome.error ?? outcome.status,
    );
    try {
      await record.inputClosure;
    } catch (error) {
      throw new RunFinalizationError(record.runId, "input-closure", error);
    }
    try {
      this.revokePermissionsForRun(
        record.runId,
        outcome.error ?? `Run ${outcome.status}`,
      );
    } catch (error) {
      throw new RunFinalizationError(record.runId, "permissions", error);
    }

    try {
      await this.deps.beforeFinalize?.(record.runId, outcome);
    } catch (error) {
      throw new RunFinalizationError(record.runId, "execution-history", error);
    }

    let ledgerRecord: RunLedgerRecord;
    try {
      // Reconcile first: a previous attempt may have committed but lost its reply.
      const current = await this.deps.runLedger.get(record.runId);
      ledgerRecord =
        current && !ACTIVE_STATUSES.has(current.status)
          ? current
          : await this.markLedgerTerminal(record, outcome);
    } catch (error) {
      try {
        const committed = await this.deps.runLedger.get(record.runId);
        if (!committed || ACTIVE_STATUSES.has(committed.status)) throw error;
        ledgerRecord = committed;
      } catch {
        throw new RunFinalizationError(record.runId, "run-terminal", error);
      }
    }
    this.applyLedgerProjection(record, ledgerRecord);
    const sameOutcome =
      ledgerRecord.status === outcome.status &&
      ledgerRecord.error === outcome.error;
    record.terminalReason = sameOutcome
      ? (outcome.terminalReason ?? outcome.result?.terminalReason)
      : undefined;
    const completion = sameOutcome
      ? completionFromResult({
          ...outcome,
          error: ledgerRecord.error,
          errorData: ledgerRecord.errorData,
        })
      : {
          status: ledgerRecord.status as RunCompletion["status"],
          error: ledgerRecord.error,
          errorData: ledgerRecord.errorData,
        };
    this.publishRunUpdated(record);
    this.endStream(record);
    this.removeActive(record);
    return completion;
  }

  private markLedgerTerminal(
    record: ManagedRunRecord,
    outcome: RunWorkerResult,
  ): Promise<RunLedgerRecord> {
    const options = { endedAt: record.finalization?.endedAt };
    if (outcome.status === "succeeded") {
      return this.deps.runLedger.markSucceeded(record.runId, options);
    }
    if (outcome.status === "cancelled") {
      return this.deps.runLedger.markCancelled(
        record.runId,
        outcome.error ?? record.cancelReason,
        options,
      );
    }
    if (outcome.status === "interrupted") {
      return this.deps.runLedger.markRunInterrupted(
        record.runId,
        outcome.error ?? record.cancelReason,
        options,
      );
    }

    return this.deps.runLedger.markFailed(
      record.runId,
      outcome.error ?? "run failed",
      outcome.errorData,
      options,
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
    record.errorData = ledgerRecord.errorData;
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

      this.cancelRun(runId, "interrupted by replacement run", "cancelled");
      completions.push(record.completion);
    }

    await Promise.all(completions);
  }

  private addActive(record: ManagedRunRecord): void {
    const key = scopedSessionKey({
      contextScopeId: record.options.contextScopeId,
      sessionId: record.sessionId,
    });
    const runIds = this.activeBySession.get(key) ?? new Set();
    runIds.add(record.runId);
    this.activeBySession.set(key, runIds);
  }

  private removeActive(record: ManagedRunRecord): void {
    const key = scopedSessionKey({
      contextScopeId: record.options.contextScopeId,
      sessionId: record.sessionId,
    });
    const runIds = this.activeBySession.get(key);
    if (!runIds) {
      return;
    }

    runIds.delete(record.runId);
    if (runIds.size === 0) {
      this.activeBySession.delete(key);
    }
  }

  private activeRunIds(input: {
    readonly contextScopeId?: string;
    readonly sessionId: string;
  }): string[] {
    const runIds = Array.from(
      this.activeBySession.get(scopedSessionKey(input)) ?? [],
    );
    return runIds.filter((runId) => {
      const record = this.recordsById.get(runId);
      return record ? isActive(record) : false;
    });
  }

  private async withSessionLock<T>(
    lockKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.sessionLocks.set(lockKey, chain);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(lockKey) === chain) {
        this.sessionLocks.delete(lockKey);
      }
    }
  }
}
