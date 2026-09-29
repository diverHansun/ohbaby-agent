import {
  createDatabaseWriteBudget,
  withDatabaseWriteBudget,
} from "../../services/database/write-budget.js";
import type {
  CurrentRunInputStore,
  SteerQueuedPromptInput,
  SteerQueuedPromptResult,
} from "./current-run-inputs.js";
import type { ReasoningConfig } from "../../config/llm/types.js";
import { sameReasoning } from "./types.js";
import { randomUUID } from "node:crypto";
import type { UiPromptError } from "ohbaby-sdk";
import {
  InvalidPromptClientRequestIdError,
  PromptIdempotencyConflictError,
  PromptSchedulerClosedError,
  PromptSubmissionNotFoundError,
  PromptSubmissionRejectedError,
  PromptWaitAbortedError,
} from "./errors.js";
import type {
  PromptSubmissionExecutor,
  PromptExecutionResult,
  PromptEditLease,
  PromptSubmissionRecord,
  PromptHistoryWindow,
  PromptSubmissionStore,
  ResubmitRetainedPromptInput,
  PromptResubmissionReceipt,
} from "./types.js";

export interface WorkspacePromptSchedulerOptions {
  readonly currentRunInputs?: CurrentRunInputStore;
  readonly onSteered?: (result: SteerQueuedPromptResult) => void;
  readonly scopeKey: string;
  readonly store: PromptSubmissionStore;
  readonly execute: PromptSubmissionExecutor;
  /** Repairs execution facts only; it must never invoke the executor again. */
  readonly recoverExecution?: (
    prompt: PromptSubmissionRecord,
    error: unknown,
    runId?: string,
  ) => Promise<PromptExecutionResult>;
  readonly withFinalizationWriteBudget?: <T>(
    runId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly isExecutionPersistenceError?: (error: unknown) => boolean;
  readonly beforeExecution?: (sessionId: string) => Promise<void>;
  readonly onRecoveryChanged?: (
    sessionId: string,
    state: PromptRecoveryState,
  ) => void;
  readonly now?: () => number;
  readonly maxActiveSessions?: number;
  readonly maxQueuedPrompts?: number;
  readonly createPromptId?: () => string;
  readonly createUserMessageId?: () => string;
  readonly isBusyError?: (error: unknown) => boolean;
  readonly busyRetryDelayMs?: number;
  readonly beforeSessionWrite?: (sessionId: string) => Promise<void>;
  readonly commitCoordinator?: {
    run<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
    runControl?<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  };
  readonly onProjectionError?: (
    error: unknown,
    prompt: PromptSubmissionRecord,
  ) => void;
  readonly onSessionInitializationError?: (
    error: unknown,
    sessionId: string,
  ) => void;
  readonly onSubmitted?: (prompt: PromptSubmissionRecord) => void;
  readonly onUpdated?: (prompt: PromptSubmissionRecord) => void;
}

export interface AcceptWorkspacePromptInput {
  readonly titleExpected?: (sessionId: string) => string | undefined;
  readonly namingSource?: import("ohbaby-sdk").UiPromptNamingSource;
  readonly reasoning?:
    | ReasoningConfig
    | ((sessionId: string) => Promise<ReasoningConfig | undefined>);
  readonly clientRequestId?: string;
  readonly expectedSessionId?: string;
  readonly sessionId: string | (() => Promise<string>);
  readonly text: string;
  readonly userMessageId?: string;
}

const TERMINAL_STATUSES = new Set([
  "steered",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export type PromptRecoveryState =
  | { readonly status: "ready" }
  | {
      readonly status: "recovering" | "blocked";
      readonly promptId: string;
      readonly message: string;
    };

interface PendingFinalization {
  readonly prompt?: PromptSubmissionRecord;
  readonly persist: () => Promise<PromptSubmissionRecord> | Promise<void>;
  error: Error;
  recovery?: Promise<void>;
}

interface CompletionWaiter {
  readonly reject: (error: Error) => void;
  readonly resolve: (prompt: PromptSubmissionRecord) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

function runtimeError(error: unknown): UiPromptError {
  if (
    typeof error === "object" &&
    error !== null &&
    "promptError" in error &&
    typeof error.promptError === "object" &&
    error.promptError !== null
  ) {
    return error.promptError as UiPromptError;
  }
  return {
    code: "RUNTIME_ERROR",
    message: error instanceof Error ? error.message : String(error),
    source: "runtime",
    retryable: false,
  };
}

export class WorkspacePromptScheduler {
  private readonly sessionSeeds = new Map<string, Promise<void>>();
  private readonly readySessions = new Set<string>();
  private readonly pendingFinalizations = new Map<
    string,
    PendingFinalization
  >();
  private readonly startingControllers = new Map<string, AbortController>();
  private readonly activeBySession = new Map<string, string>();
  private readonly completionWaiters = new Map<string, Set<CompletionWaiter>>();
  private readonly busySessionsUntil = new Map<string, number>();
  private readonly maxActiveSessions: number;
  private readonly maxQueuedPrompts: number;
  private readonly entryFailures = new Map<string, Error>();
  private readonly entryAttempts = new Map<string, Promise<void>>();
  private readonly executions = new Set<Promise<void>>();
  private closed = false;
  private terminalError: Error | undefined;
  private draining = false;
  private drainAgain = false;
  private initialized = false;
  private readonly acceptanceBarriers = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkspacePromptSchedulerOptions) {
    this.maxActiveSessions = options.maxActiveSessions ?? 10;
    this.maxQueuedPrompts = options.maxQueuedPrompts ?? 100;
    if (
      !Number.isInteger(this.maxActiveSessions) ||
      this.maxActiveSessions < 1
    ) {
      throw new RangeError("maxActiveSessions must be a positive integer");
    }
    if (!Number.isInteger(this.maxQueuedPrompts) || this.maxQueuedPrompts < 1) {
      throw new RangeError("maxQueuedPrompts must be a positive integer");
    }
  }

  init(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    this.initialized = true;
    this.requestDrain();
    return Promise.resolve();
  }

  async accept(
    input: AcceptWorkspacePromptInput,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    await this.init();
    const explicitSessionId =
      input.expectedSessionId ??
      (typeof input.sessionId === "string" ? input.sessionId : undefined);
    const admissionKey =
      explicitSessionId === undefined
        ? "implicit"
        : `session:${explicitSessionId}`;
    let unlock!: () => void;
    const previous = this.acceptanceBarriers.get(admissionKey);
    const barrier = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.acceptanceBarriers.set(admissionKey, barrier);
    const release = (): void => {
      unlock();
      if (this.acceptanceBarriers.get(admissionKey) === barrier)
        this.acceptanceBarriers.delete(admissionKey);
    };
    await previous;
    let knownUnaccepted = false;
    try {
      this.assertOpen();
      if (
        input.clientRequestId !== undefined &&
        (input.clientRequestId.trim() === "" ||
          input.clientRequestId.startsWith("legacy:"))
      ) {
        throw new InvalidPromptClientRequestIdError(input.clientRequestId);
      }
      const clientRequestId = input.clientRequestId ?? randomUUID();
      const existing = await this.options.store.getByClientRequestId(
        this.options.scopeKey,
        clientRequestId,
      );
      this.assertOpen();
      if (existing) {
        const expectedSessionId =
          input.expectedSessionId ??
          (typeof input.sessionId === "string" ? input.sessionId : undefined);
        if (
          existing.text !== input.text ||
          (typeof input.reasoning !== "function" &&
            input.reasoning !== undefined &&
            !sameReasoning(existing.reasoning, input.reasoning)) ||
          (expectedSessionId !== undefined &&
            existing.sessionId !== expectedSessionId)
        ) {
          throw new PromptIdempotencyConflictError(clientRequestId);
        }
        return existing;
      }
      knownUnaccepted = true;
      await this.options.store.assertCapacity(
        this.options.scopeKey,
        this.maxQueuedPrompts,
      );
      this.assertOpen();
      const sessionId =
        typeof input.sessionId === "function"
          ? await input.sessionId()
          : input.sessionId;
      this.assertOpen();
      // Session initialization is independent of the workspace admission lane.
      // Release it before waiting so an unavailable session cannot block others.
      release();
      await this.recoverSession(sessionId);
      this.assertOpen();
      const reasoning =
        typeof input.reasoning === "function"
          ? await input.reasoning(sessionId)
          : input.reasoning;
      const prompt = await this.commit(sessionId, async () => {
        this.assertOpen();
        const blocked =
          this.pendingFinalizations.get(sessionId)?.error ??
          this.entryFailures.get(sessionId);
        if (blocked) throw blocked;
        knownUnaccepted = false;
        const accepted = await this.options.store.accept({
          clientRequestId,
          maxQueuedPrompts: this.maxQueuedPrompts,
          promptId: this.options.createPromptId?.() ?? `prompt_${randomUUID()}`,
          scopeKey: this.options.scopeKey,
          sessionId,
          text: input.text,
          namingSource: input.namingSource,
          titleExpected: input.titleExpected?.(sessionId),
          reasoning,
          userMessageId:
            input.userMessageId ??
            this.options.createUserMessageId?.() ??
            `message_${randomUUID()}`,
        });
        // The durable receipt survives projection failures and shutdown races.
        if (accepted.inserted)
          this.notify(accepted.record, this.options.onSubmitted);
        return accepted.record;
      });
      this.requestDrain();
      return prompt;
    } catch (error) {
      if (knownUnaccepted && !(error instanceof Error && "code" in error))
        throw new PromptSubmissionRejectedError(error);
      throw error;
    } finally {
      release();
    }
  }

  async resubmitRetained(
    input: Omit<ResubmitRetainedPromptInput, "scopeKey" | "maxQueuedPrompts">,
  ): Promise<PromptResubmissionReceipt> {
    this.assertOpen();
    // Historical successful operations remain authoritative even after capacity changes.
    const receipt = await this.options.store.getResubmissionReceipt(
      this.options.scopeKey,
      input.operationId,
    );
    if (receipt && receipt.promptId !== input.promptId)
      throw new PromptIdempotencyConflictError(input.operationId);
    const prompt = await this.options.store.get(input.promptId);
    if (prompt?.scopeKey !== this.options.scopeKey)
      throw new PromptSubmissionNotFoundError(input.promptId);
    if (!receipt) await this.recoverSession(prompt.sessionId);
    const result = await this.commit(prompt.sessionId, async () => {
      this.assertOpen();
      const committedReceipt =
        receipt ??
        (await this.options.store.getResubmissionReceipt(
          this.options.scopeKey,
          input.operationId,
        ));
      if (!committedReceipt) {
        const blocked =
          this.pendingFinalizations.get(prompt.sessionId)?.error ??
          this.entryFailures.get(prompt.sessionId);
        if (blocked) throw blocked;
      }
      return this.options.store.resubmitRetained({
        ...input,
        scopeKey: this.options.scopeKey,
        maxQueuedPrompts: this.maxQueuedPrompts,
      });
    });
    if (result.inserted) this.notify(result.record, this.options.onUpdated);
    this.requestDrain();
    return result.receipt;
  }

  async steerQueued(
    input: SteerQueuedPromptInput,
  ): Promise<SteerQueuedPromptResult> {
    this.assertOpen();
    if (!this.options.currentRunInputs)
      throw new Error("Current-run inputs are unavailable");
    const inputs = this.options.currentRunInputs;
    const source = await this.options.store.get(input.promptId);
    if (!source) throw new PromptSubmissionNotFoundError(input.promptId);
    await this.recoverSession(source.sessionId);
    this.assertOpen();
    const result = await this.mutatePrompt(input.promptId, async () => {
      const result = await inputs.steerQueued({
        ...input,
        scopeKey: this.options.scopeKey,
      });
      this.notify(result.prompt, this.options.onUpdated);
      try {
        this.options.onSteered?.(result);
      } catch (error) {
        this.options.onProjectionError?.(error, result.prompt);
      }
      return result;
    });
    this.resolveCompletion(result.prompt);
    this.requestDrain();
    return result;
  }

  async acquireEditLease(
    promptId: string,
    ownerClientId: string,
    ttlMs = 60_000,
  ): Promise<PromptEditLease> {
    this.assertOpen();
    const lease = await this.mutatePrompt(promptId, async () => {
      const result = await this.options.store.acquireEditLease(
        promptId,
        ownerClientId,
        ttlMs,
      );
      this.notify(result.prompt, this.options.onUpdated);
      return result;
    });
    this.requestDrain(Math.max(1, lease.expiresAt - Date.now()));
    return lease;
  }

  async renewEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId: string,
    ttlMs = 60_000,
  ): Promise<PromptEditLease> {
    this.assertOpen();
    const lease = await this.mutatePrompt(promptId, async () => {
      const result = await this.options.store.renewEditLease(
        promptId,
        editLeaseId,
        ownerClientId,
        ttlMs,
      );
      this.notify(result.prompt, this.options.onUpdated);
      return result;
    });
    this.requestDrain(Math.max(1, lease.expiresAt - Date.now()));
    return lease;
  }

  async commitEdit(
    promptId: string,
    editLeaseId: string,
    text: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    const prompt = await this.mutatePrompt(promptId, async () => {
      const result = await this.options.store.commitEdit(
        promptId,
        editLeaseId,
        text,
        ownerClientId,
      );
      this.notify(result, this.options.onUpdated);
      return result;
    });
    this.requestDrain();
    return prompt;
  }

  async releaseEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    const prompt = await this.mutatePrompt(promptId, async () => {
      const result = await this.options.store.releaseEditLease(
        promptId,
        editLeaseId,
        ownerClientId,
      );
      this.notify(result, this.options.onUpdated);
      return result;
    });
    this.requestDrain();
    return prompt;
  }

  async cancelQueued(
    promptId: string,
    editLeaseId?: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    const starting = this.startingControllers.get(promptId);
    if (starting) {
      // Stop an admission that has not completed the run-start handshake.
      starting.abort("Queued prompt cancelled");
      const cancelled = await this.mutatePrompt(
        promptId,
        async () => {
          const result = await this.options.store.finish(promptId, {
            status: "cancelled",
          });
          this.notify(result, this.options.onUpdated);
          return result;
        },
        true,
      );
      this.resolveCompletion(cancelled);
      return cancelled;
    }
    const prompt = await this.mutatePrompt(
      promptId,
      async () => {
        const result = await this.options.store.cancelQueued(
          promptId,
          editLeaseId,
          ownerClientId,
        );
        this.notify(result, this.options.onUpdated);
        return result;
      },
      true,
    );
    this.resolveCompletion(prompt);
    this.requestDrain();
    return prompt;
  }

  async get(promptId: string): Promise<PromptSubmissionRecord | undefined> {
    return this.options.store.get(promptId);
  }

  async getByClientRequestId(
    clientRequestId: string,
  ): Promise<PromptSubmissionRecord | undefined> {
    return this.options.store.getByClientRequestId(
      this.options.scopeKey,
      clientRequestId,
    );
  }

  async listForSession(
    sessionId: string,
    window: PromptHistoryWindow = {},
  ): Promise<readonly PromptSubmissionRecord[]> {
    return this.options.store.listForSession(
      this.options.scopeKey,
      sessionId,
      window,
    );
  }

  async listVisible(): Promise<readonly PromptSubmissionRecord[]> {
    return this.options.store.listVisible(this.options.scopeKey);
  }

  async waitForCompletion(
    promptId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    if (options.signal?.aborted) {
      throw new PromptWaitAbortedError(promptId);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.completionWaiters.get(promptId) ?? new Set();
      const waiter: CompletionWaiter = {
        reject,
        resolve,
        settled: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      if (options.signal) {
        waiter.onAbort = (): void => {
          this.rejectCompletionWaiter(
            promptId,
            waiter,
            new PromptWaitAbortedError(promptId),
          );
        };
        options.signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }
      waiters.add(waiter);
      this.completionWaiters.set(promptId, waiters);

      void this.options.store
        .get(promptId)
        .then((current) => {
          if (current) {
            const pending = this.pendingFinalizations.get(current.sessionId);
            if (pending?.prompt?.promptId === promptId) {
              this.rejectCompletionWaiter(promptId, waiter, pending.error);
              return;
            }
          }
          if (waiter.settled) {
            return;
          }
          if (!current) {
            this.rejectCompletionWaiter(
              promptId,
              waiter,
              new PromptSubmissionNotFoundError(promptId),
            );
            return;
          }
          if (TERMINAL_STATUSES.has(current.status)) {
            this.resolveCompletionWaiter(promptId, waiter, current);
          }
        })
        .catch((error: unknown) => {
          this.rejectCompletionWaiter(
            promptId,
            waiter,
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  getRecoveryState(sessionId: string): PromptRecoveryState {
    const pending = this.pendingFinalizations.get(sessionId);
    const entryError = this.entryFailures.get(sessionId);
    if (this.entryAttempts.has(sessionId) && (pending || entryError))
      return {
        status: "recovering",
        promptId: pending?.prompt?.promptId ?? "",
        message: entryError?.message ?? "Checking execution records",
      };
    if (entryError)
      return {
        status: this.entryAttempts.has(sessionId) ? "recovering" : "blocked",
        promptId: pending?.prompt?.promptId ?? "",
        message: entryError.message,
      };
    return pending
      ? {
          status: pending.recovery ? "recovering" : "blocked",
          promptId: pending.prompt?.promptId ?? "",
          message: pending.error.message,
        }
      : { status: "ready" };
  }

  /** Explicit reconnect/enter/execute recovery. Ordinary reads never call this. */
  recoverSession(sessionId: string): Promise<void> {
    this.assertOpen();
    const existing = this.entryAttempts.get(sessionId);
    if (existing) return existing;
    const attempt = Promise.resolve().then(async () => {
      try {
        await this.recoverFinalization(sessionId);
        await this.options.beforeExecution?.(sessionId);
        await this.seedSession(sessionId);
        this.entryFailures.delete(sessionId);
        this.requestDrain();
      } catch (error) {
        this.entryFailures.set(
          sessionId,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      } finally {
        this.entryAttempts.delete(sessionId);
        this.publishRecovery(sessionId);
      }
    });
    this.entryAttempts.set(sessionId, attempt);
    this.publishRecovery(sessionId);
    return attempt;
  }

  private recoverFinalization(sessionId: string): Promise<void> {
    const pending = this.pendingFinalizations.get(sessionId);
    if (!pending) return Promise.resolve();
    if (pending.recovery) return pending.recovery;
    const recovery = Promise.resolve().then(async () => {
      try {
        const record = await withDatabaseWriteBudget(
          createDatabaseWriteBudget(),
          pending.persist,
        );
        if (this.pendingFinalizations.get(sessionId) === pending) {
          this.pendingFinalizations.delete(sessionId);
          if (record) this.resolveCompletion(record);
        }
      } catch (error) {
        pending.error =
          error instanceof Error ? error : new Error(String(error));
        throw pending.error;
      } finally {
        pending.recovery = undefined;
        this.publishRecovery(sessionId);
      }
      // Re-read the queue in drain: edits/deletions and shutdown can win recovery.
      this.requestDrain();
    });
    pending.recovery = recovery;
    this.publishRecovery(sessionId);
    return recovery;
  }

  private publishRecovery(sessionId: string): void {
    try {
      this.options.onRecoveryChanged?.(
        sessionId,
        this.getRecoveryState(sessionId),
      );
    } catch {
      /* Projection observers cannot change durable execution facts. */
    }
  }

  /** A goal-owned Run has no queued prompt, but shares the same session gate. */
  blockExecutionFinalization(
    sessionId: string,
    error: Error,
    persist: () => Promise<void>,
  ): void {
    this.pendingFinalizations.set(sessionId, { error, persist });
    this.publishRecovery(sessionId);
  }

  private blockFinalization(
    prompt: PromptSubmissionRecord,
    error: unknown,
    persist: PendingFinalization["persist"],
  ): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.pendingFinalizations.set(prompt.sessionId, {
      prompt,
      error: normalized,
      persist,
    });
    for (const waiter of this.completionWaiters.get(prompt.promptId) ?? []) {
      this.rejectCompletionWaiter(prompt.promptId, waiter, normalized);
    }
    this.publishRecovery(prompt.sessionId);
  }

  private async persistResult(
    prompt: PromptSubmissionRecord,
    result: PromptExecutionResult,
    runId?: string,
  ): Promise<PromptSubmissionRecord> {
    const persist = (): Promise<PromptSubmissionRecord> =>
      this.commit(prompt.sessionId, async () => {
        // A committed result may have lost its acknowledgement. Re-read before retry.
        const current = await this.options.store.get(prompt.promptId);
        if (current && TERMINAL_STATUSES.has(current.status)) {
          if (runId !== undefined && current.runId !== runId)
            throw new Error(
              `Prompt ${prompt.promptId} terminal belongs to another run`,
            );
          this.notify(current, this.options.onUpdated);
          return current;
        }
        const record = await this.options.store.finish(prompt.promptId, {
          ...result,
          expectedRunId: runId,
        });
        this.notify(record, this.options.onUpdated);
        return record;
      });
    return runId && this.options.withFinalizationWriteBudget
      ? this.options.withFinalizationWriteBudget(runId, persist)
      : persist();
  }

  activeCount(): number {
    return this.activeBySession.size;
  }

  async hasPendingSession(sessionId: string): Promise<boolean> {
    if (
      this.activeBySession.has(sessionId) ||
      this.pendingFinalizations.has(sessionId)
    ) {
      return true;
    }
    return (await this.options.store.listQueued(this.options.scopeKey)).some(
      (prompt) => prompt.sessionId === sessionId,
    );
  }

  close(): void {
    for (const controller of this.startingControllers.values())
      controller.abort("Scheduler closed");
    if (this.closed) {
      return;
    }
    const error = new PromptSchedulerClosedError();
    this.closed = true;
    this.terminalError = error;
    this.rejectAllCompletionWaiters(error);
  }

  async settleShutdown(): Promise<void> {
    this.close();
    await this.options.store.retainOwnedQueued(this.options.scopeKey);
    await Promise.all([...this.executions]);
    const pending = [...this.pendingFinalizations.keys()];
    const results = await Promise.allSettled(
      pending.map((sessionId) => this.recoverFinalization(sessionId)),
    );
    const errors = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Prompt finalization is unconfirmed");
    await this.options.store.recoverAllInterrupted({
      scopeKey: this.options.scopeKey,
      includeCurrentOwner: true,
    });
  }

  private seedSession(sessionId: string): Promise<void> {
    const existing = this.sessionSeeds.get(sessionId);
    if (existing) return existing;
    const seed = Promise.resolve()
      .then(() => this.options.beforeSessionWrite?.(sessionId))
      .then(
        () => {
          this.readySessions.add(sessionId);
          this.busySessionsUntil.delete(sessionId);
        },
        (error: unknown) => {
          this.sessionSeeds.delete(sessionId);
          this.entryFailures.set(
            sessionId,
            error instanceof Error ? error : new Error(String(error)),
          );
          try {
            this.options.onSessionInitializationError?.(error, sessionId);
          } catch {
            /* Observers cannot affect other sessions. */
          }
          throw error;
        },
      );
    this.sessionSeeds.set(sessionId, seed);
    return seed;
  }

  private async commit<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.seedSession(sessionId);
    return (
      this.options.commitCoordinator?.run(sessionId, operation) ?? operation()
    );
  }

  private async mutatePrompt<T>(
    promptId: string,
    operation: () => Promise<T>,
    controlOnly = false,
  ): Promise<T> {
    const current = await this.options.store.get(promptId);
    if (!current) throw new PromptSubmissionNotFoundError(promptId);
    if (controlOnly) {
      const coordinator = this.options.commitCoordinator;
      if (coordinator?.runControl)
        return coordinator.runControl(current.sessionId, operation);
      if (coordinator && this.readySessions.has(current.sessionId))
        return coordinator.run(current.sessionId, operation);
      return operation();
    }
    return this.commit(current.sessionId, operation);
  }

  private notify(
    prompt: PromptSubmissionRecord,
    listener: ((prompt: PromptSubmissionRecord) => void) | undefined,
  ): void {
    try {
      listener?.(prompt);
    } catch (error) {
      try {
        this.options.onProjectionError?.(error, prompt);
      } catch {
        /* Keep committed business results. */
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw this.terminalError ?? new PromptSchedulerClosedError();
    }
  }

  private requestDrain(delayMs = 0): void {
    if (this.closed || !this.initialized) {
      return;
    }
    if (delayMs > 0) {
      setTimeout(() => {
        this.requestDrain();
      }, delayMs).unref();
      return;
    }
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    void this.drain().catch((error: unknown) => {
      this.fault(error);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) {
      return;
    }
    this.draining = true;
    try {
      this.drainAgain = false;
      while (
        !this.isClosed() &&
        this.activeBySession.size < this.maxActiveSessions
      ) {
        const queued = await this.options.store.listQueued(
          this.options.scopeKey,
        );
        if (this.isClosed()) {
          break;
        }
        const now = Date.now();
        for (const [sessionId, blockedUntil] of this.busySessionsUntil) {
          if (blockedUntil <= now) {
            this.busySessionsUntil.delete(sessionId);
          }
        }
        const laneHeads = new Map<string, PromptSubmissionRecord>();
        for (const prompt of queued) {
          if (!laneHeads.has(prompt.sessionId)) {
            laneHeads.set(prompt.sessionId, prompt);
          }
        }
        const candidate = [...laneHeads.values()].find(
          (prompt) =>
            !this.activeBySession.has(prompt.sessionId) &&
            !this.pendingFinalizations.has(prompt.sessionId) &&
            !this.entryFailures.has(prompt.sessionId) &&
            !this.entryAttempts.has(prompt.sessionId) &&
            !this.busySessionsUntil.has(prompt.sessionId) &&
            (!this.sessionSeeds.has(prompt.sessionId) ||
              this.readySessions.has(prompt.sessionId)) &&
            (prompt.editLeaseExpiresAt ?? 0) <= now,
        );
        if (!candidate) {
          const nextRetryAt = Math.min(
            ...[...laneHeads.values()].flatMap((prompt) => {
              if (
                this.pendingFinalizations.has(prompt.sessionId) ||
                this.entryFailures.has(prompt.sessionId)
              )
                return [];
              const blockedUntil = this.busySessionsUntil.get(prompt.sessionId);
              const leaseExpiresAt = prompt.editLeaseExpiresAt;
              return [
                ...(blockedUntil === undefined ? [] : [blockedUntil]),
                ...(leaseExpiresAt === undefined || leaseExpiresAt <= now
                  ? []
                  : [leaseExpiresAt]),
              ];
            }),
          );
          if (Number.isFinite(nextRetryAt)) {
            this.requestDrain(Math.max(1, nextRetryAt - now));
          }
          break;
        }
        if (!this.readySessions.has(candidate.sessionId)) {
          void this.recoverSession(candidate.sessionId).then(
            () => {
              this.requestDrain();
            },
            () => {
              this.requestDrain();
            },
          );
          continue;
        }
        const claimed = await this.commit(candidate.sessionId, async () => {
          const result = await this.options.store.claim(candidate.promptId);
          if (result) this.notify(result, this.options.onUpdated);
          return result;
        });
        if (!claimed) {
          continue;
        }
        if (this.isClosed()) {
          try {
            await this.commit(claimed.sessionId, async () => {
              const queued = await this.options.store.requeueBusy(
                claimed.promptId,
              );
              this.notify(queued, this.options.onUpdated);
            });
          } catch {
            // Startup recovery will reconcile a claim that cannot be requeued
            // after the scheduler has already entered its terminal state.
          }
          break;
        }
        this.activeBySession.set(claimed.sessionId, claimed.promptId);
        const execution = this.executeClaimed(claimed);
        this.executions.add(execution);
        void execution
          .finally(() => this.executions.delete(execution))
          .catch((error: unknown) => {
            this.fault(error);
          });
      }
    } finally {
      this.draining = false;
      if (this.drainAgain && !this.isClosed()) {
        this.requestDrain();
      }
    }
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private async executeClaimed(prompt: PromptSubmissionRecord): Promise<void> {
    const starting = new AbortController();
    const isStartingCancelled = (): boolean => starting.signal.aborted;
    this.startingControllers.set(prompt.promptId, starting);
    let runId: string | undefined;
    let runningPersistenceError: Error | undefined;
    try {
      let result;
      try {
        result = await this.options.execute(prompt, {
          signal: starting.signal,
          markRunning: async (nextRunId): Promise<void> => {
            starting.signal.throwIfAborted();
            this.startingControllers.delete(prompt.promptId);
            runId = nextRunId;
            try {
              await this.commit(prompt.sessionId, async () => {
                const running = await this.options.store.markRunning(
                  prompt.promptId,
                  nextRunId,
                );
                runId = nextRunId;
                this.notify(running, this.options.onUpdated);
              });
            } catch (error) {
              runningPersistenceError =
                error instanceof Error ? error : new Error(String(error));
              throw runningPersistenceError;
            }
          },
        });
      } catch (error) {
        if (isStartingCancelled()) return;
        if (runningPersistenceError) {
          const failure = runningPersistenceError;
          const targetRunId = runId;
          this.blockFinalization(prompt, failure, async () => {
            if (!targetRunId || !this.options.recoverExecution) throw failure;
            const result = await this.options.recoverExecution(
              prompt,
              failure,
              targetRunId,
            );
            const current = await this.options.store.get(prompt.promptId);
            if (current?.status === "starting")
              await this.commit(prompt.sessionId, () =>
                this.options.store.markRunning(prompt.promptId, targetRunId),
              );
            return this.persistResult(prompt, result, targetRunId);
          });
          return;
        }
        // A different owner can fail while this claimed prompt waits for its
        // runtime slot. Preserve this prompt; it does not own that Run's outcome.
        if (
          runId === undefined &&
          (this.pendingFinalizations.has(prompt.sessionId) ||
            this.entryFailures.has(prompt.sessionId))
        ) {
          await this.commit(prompt.sessionId, async () => {
            const queued = await this.options.store.requeueBusy(
              prompt.promptId,
            );
            this.notify(queued, this.options.onUpdated);
          });
          return;
        }
        if (this.options.isBusyError?.(error) && runId === undefined) {
          try {
            await this.commit(prompt.sessionId, async () => {
              const queued = await this.options.store.requeueBusy(
                prompt.promptId,
              );
              this.notify(queued, this.options.onUpdated);
            });
            if (isStartingCancelled()) return;
            this.busySessionsUntil.set(
              prompt.sessionId,
              Date.now() + (this.options.busyRetryDelayMs ?? 250),
            );
          } catch (storageError) {
            if (!isStartingCancelled()) this.fault(storageError);
          }
          return;
        }
        this.busySessionsUntil.delete(prompt.sessionId);
        if (this.options.isExecutionPersistenceError?.(error)) {
          this.blockFinalization(prompt, error, async () => {
            if (!this.options.recoverExecution) throw error;
            const recovered = await this.options.recoverExecution(
              prompt,
              error,
            );
            return this.persistResult(prompt, recovered, runId);
          });
          return;
        }
        const failure: PromptExecutionResult = {
          status: "failed",
          error: runtimeError(error),
          endedAt: this.options.now?.() ?? Date.now(),
        };
        const persist = (): Promise<PromptSubmissionRecord> =>
          this.persistResult(prompt, failure, runId);
        try {
          this.resolveCompletion(await persist());
        } catch (storageError) {
          this.blockFinalization(prompt, storageError, persist);
        }
        return;
      }

      if (isStartingCancelled()) return;
      const settledAt = result.endedAt ?? this.options.now?.();
      const terminal = {
        ...result,
        ...(settledAt === undefined ? {} : { endedAt: settledAt }),
      };
      const persist = (): Promise<PromptSubmissionRecord> =>
        this.persistResult(prompt, terminal, runId);
      try {
        this.resolveCompletion(await persist());
      } catch (storageError) {
        const originalEnd = terminal.endedAt ?? Date.now();
        this.blockFinalization(prompt, storageError, () =>
          this.persistResult(
            prompt,
            { ...terminal, endedAt: originalEnd },
            runId,
          ),
        );
      }
    } finally {
      this.startingControllers.delete(prompt.promptId);
      if (this.activeBySession.get(prompt.sessionId) === prompt.promptId) {
        this.activeBySession.delete(prompt.sessionId);
      }
      this.requestDrain();
    }
  }

  private resolveCompletion(prompt: PromptSubmissionRecord): void {
    const waiters = this.completionWaiters.get(prompt.promptId);
    if (!waiters) {
      return;
    }
    this.completionWaiters.delete(prompt.promptId);
    for (const waiter of waiters) {
      this.resolveCompletionWaiter(prompt.promptId, waiter, prompt);
    }
  }

  private resolveCompletionWaiter(
    promptId: string,
    waiter: CompletionWaiter,
    prompt: PromptSubmissionRecord,
  ): void {
    this.settleCompletionWaiter(promptId, waiter, () => {
      waiter.resolve(prompt);
    });
  }

  private rejectCompletionWaiter(
    promptId: string,
    waiter: CompletionWaiter,
    error: Error,
  ): void {
    this.settleCompletionWaiter(promptId, waiter, () => {
      waiter.reject(error);
    });
  }

  private settleCompletionWaiter(
    promptId: string,
    waiter: CompletionWaiter,
    settle: () => void,
  ): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    const waiters = this.completionWaiters.get(promptId);
    if (waiters) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        this.completionWaiters.delete(promptId);
      }
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    settle();
  }

  private rejectAllCompletionWaiters(error: Error): void {
    for (const [promptId, waiters] of this.completionWaiters) {
      for (const waiter of waiters) {
        this.rejectCompletionWaiter(promptId, waiter, error);
      }
    }
  }

  private fault(error: unknown): void {
    if (this.closed) {
      return;
    }
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.terminalError = normalized;
    this.rejectAllCompletionWaiters(normalized);
  }
}
