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
  PromptEditLease,
  PromptSubmissionRecord,
  PromptHistoryWindow,
  PromptSubmissionStore,
} from "./types.js";

export interface WorkspacePromptSchedulerOptions {
  readonly currentRunInputs?: CurrentRunInputStore;
  readonly onSteered?: (result: SteerQueuedPromptResult) => void;
  readonly scopeKey: string;
  readonly store: PromptSubmissionStore;
  readonly execute: PromptSubmissionExecutor;
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
  private readonly startingControllers = new Map<string, AbortController>();
  private readonly activeBySession = new Map<string, string>();
  private readonly completionWaiters = new Map<string, Set<CompletionWaiter>>();
  private readonly busySessionsUntil = new Map<string, number>();
  private readonly maxActiveSessions: number;
  private readonly maxQueuedPrompts: number;
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
      const reasoning =
        typeof input.reasoning === "function"
          ? await input.reasoning(sessionId)
          : input.reasoning;
      const prompt = await this.commit(sessionId, async () => {
        this.assertOpen();
        knownUnaccepted = false;
        const accepted = await this.options.store.accept({
          clientRequestId,
          maxQueuedPrompts: this.maxQueuedPrompts,
          promptId: this.options.createPromptId?.() ?? `prompt_${randomUUID()}`,
          scopeKey: this.options.scopeKey,
          sessionId,
          text: input.text,
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

  async steerQueued(
    input: SteerQueuedPromptInput,
  ): Promise<SteerQueuedPromptResult> {
    this.assertOpen();
    if (!this.options.currentRunInputs)
      throw new Error("Current-run inputs are unavailable");
    const inputs = this.options.currentRunInputs;
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

  activeCount(): number {
    return this.activeBySession.size;
  }

  async hasPendingSession(sessionId: string): Promise<boolean> {
    if (this.activeBySession.has(sessionId)) {
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
          this.busySessionsUntil.set(
            sessionId,
            Date.now() + Math.max(1, this.options.busyRetryDelayMs ?? 250),
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
    if (this.closed) {
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
            !this.busySessionsUntil.has(prompt.sessionId) &&
            (!this.sessionSeeds.has(prompt.sessionId) ||
              this.readySessions.has(prompt.sessionId)) &&
            (prompt.editLeaseExpiresAt ?? 0) <= now,
        );
        if (!candidate) {
          const nextRetryAt = Math.min(
            ...[...laneHeads.values()].flatMap((prompt) => {
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
          void this.seedSession(candidate.sessionId).then(
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
        void this.executeClaimed(claimed);
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
          this.fault(runningPersistenceError);
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
        try {
          const failed = await this.commit(prompt.sessionId, async () => {
            const result = await this.options.store.finish(prompt.promptId, {
              status: "failed",
              expectedRunId: runId,
              error: runtimeError(error),
            });
            this.notify(result, this.options.onUpdated);
            return result;
          });
          this.resolveCompletion(failed);
        } catch (storageError) {
          this.fault(storageError);
        }
        return;
      }

      if (isStartingCancelled()) return;
      try {
        const finished = await this.commit(prompt.sessionId, async () => {
          const record = await this.options.store.finish(prompt.promptId, {
            ...result,
            expectedRunId: runId,
          });
          this.notify(record, this.options.onUpdated);
          return record;
        });
        this.resolveCompletion(finished);
      } catch (storageError) {
        this.fault(storageError);
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
