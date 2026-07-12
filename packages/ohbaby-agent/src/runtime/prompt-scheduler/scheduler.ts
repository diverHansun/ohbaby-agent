import { randomUUID } from "node:crypto";
import type { UiPromptError } from "ohbaby-sdk";
import {
  PromptSchedulerClosedError,
  PromptSubmissionNotFoundError,
} from "./errors.js";
import type {
  PromptSubmissionExecutor,
  PromptSubmissionRecord,
  PromptSubmissionStore,
} from "./types.js";

export interface WorkspacePromptSchedulerOptions {
  readonly scopeKey: string;
  readonly store: PromptSubmissionStore;
  readonly execute: PromptSubmissionExecutor;
  readonly maxActiveSessions?: number;
  readonly maxQueuedPrompts?: number;
  readonly createPromptId?: () => string;
  readonly createUserMessageId?: () => string;
  readonly isBusyError?: (error: unknown) => boolean;
  readonly busyRetryDelayMs?: number;
  readonly onSubmitted?: (prompt: PromptSubmissionRecord) => void;
  readonly onUpdated?: (prompt: PromptSubmissionRecord) => void;
}

export interface AcceptWorkspacePromptInput {
  readonly sessionId: string | (() => Promise<string>);
  readonly text: string;
  readonly userMessageId?: string;
}

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

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
  private readonly activeBySession = new Map<string, string>();
  private readonly completionWaiters = new Map<
    string,
    Set<(prompt: PromptSubmissionRecord) => void>
  >();
  private readonly busySessionsUntil = new Map<string, number>();
  private readonly maxActiveSessions: number;
  private readonly maxQueuedPrompts: number;
  private closed = false;
  private draining = false;
  private drainAgain = false;
  private initialized = false;
  private acceptanceBarrier: Promise<void> = Promise.resolve();

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
    let release!: () => void;
    const previous = this.acceptanceBarrier;
    this.acceptanceBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.options.store.assertCapacity(
        this.options.scopeKey,
        this.maxQueuedPrompts,
      );
      const sessionId =
        typeof input.sessionId === "function"
          ? await input.sessionId()
          : input.sessionId;
      const prompt = await this.options.store.accept({
        maxQueuedPrompts: this.maxQueuedPrompts,
        promptId: this.options.createPromptId?.() ?? `prompt_${randomUUID()}`,
        scopeKey: this.options.scopeKey,
        sessionId,
        text: input.text,
        userMessageId:
          input.userMessageId ??
          this.options.createUserMessageId?.() ??
          `message_${randomUUID()}`,
      });
      this.options.onSubmitted?.(prompt);
      this.requestDrain();
      return prompt;
    } finally {
      release();
    }
  }

  async editQueued(
    promptId: string,
    expectedUpdatedAt: number,
    text: string,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    const prompt = await this.options.store.editQueued(
      promptId,
      expectedUpdatedAt,
      text,
    );
    this.options.onUpdated?.(prompt);
    return prompt;
  }

  async cancelQueued(
    promptId: string,
    expectedUpdatedAt: number,
  ): Promise<PromptSubmissionRecord> {
    this.assertOpen();
    const prompt = await this.options.store.cancelQueued(
      promptId,
      expectedUpdatedAt,
    );
    this.options.onUpdated?.(prompt);
    this.resolveCompletion(prompt);
    this.requestDrain();
    return prompt;
  }

  async get(promptId: string): Promise<PromptSubmissionRecord | undefined> {
    return this.options.store.get(promptId);
  }

  async listVisible(): Promise<readonly PromptSubmissionRecord[]> {
    return this.options.store.listVisible(this.options.scopeKey);
  }

  async waitForCompletion(promptId: string): Promise<PromptSubmissionRecord> {
    return new Promise((resolve, reject) => {
      const waiters = this.completionWaiters.get(promptId) ?? new Set();
      waiters.add(resolve);
      this.completionWaiters.set(promptId, waiters);

      void this.options.store
        .get(promptId)
        .then((current) => {
          if (!current) {
            this.removeCompletionWaiter(promptId, resolve);
            reject(new PromptSubmissionNotFoundError(promptId));
            return;
          }
          if (TERMINAL_STATUSES.has(current.status)) {
            this.removeCompletionWaiter(promptId, resolve);
            resolve(current);
          }
        })
        .catch((error: unknown) => {
          this.removeCompletionWaiter(promptId, resolve);
          reject(error instanceof Error ? error : new Error(String(error)));
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
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PromptSchedulerClosedError();
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
    void this.drain();
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
        const now = Date.now();
        for (const [sessionId, blockedUntil] of this.busySessionsUntil) {
          if (blockedUntil <= now) {
            this.busySessionsUntil.delete(sessionId);
          }
        }
        const candidate = queued.find(
          (prompt) =>
            !this.activeBySession.has(prompt.sessionId) &&
            !this.busySessionsUntil.has(prompt.sessionId),
        );
        if (!candidate) {
          const nextRetryAt = Math.min(
            ...queued.flatMap((prompt) => {
              const blockedUntil = this.busySessionsUntil.get(prompt.sessionId);
              return blockedUntil === undefined ? [] : [blockedUntil];
            }),
          );
          if (Number.isFinite(nextRetryAt)) {
            this.requestDrain(Math.max(1, nextRetryAt - now));
          }
          break;
        }
        const claimed = await this.options.store.claim(candidate.promptId);
        if (!claimed) {
          continue;
        }
        this.activeBySession.set(claimed.sessionId, claimed.promptId);
        this.options.onUpdated?.(claimed);
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
    let runId: string | undefined;
    try {
      const result = await this.options.execute(prompt, {
        markRunning: async (nextRunId): Promise<void> => {
          const running = await this.options.store.markRunning(
            prompt.promptId,
            nextRunId,
          );
          runId = nextRunId;
          this.options.onUpdated?.(running);
        },
      });
      const finished = await this.options.store.finish(prompt.promptId, {
        status: result.status,
        expectedRunId: runId,
        error: result.error,
      });
      this.options.onUpdated?.(finished);
      this.resolveCompletion(finished);
    } catch (error) {
      if (this.options.isBusyError?.(error) && runId === undefined) {
        const queued = await this.options.store.requeueBusy(prompt.promptId);
        this.options.onUpdated?.(queued);
        this.busySessionsUntil.set(
          prompt.sessionId,
          Date.now() + (this.options.busyRetryDelayMs ?? 250),
        );
      } else {
        this.busySessionsUntil.delete(prompt.sessionId);
        const failed = await this.options.store
          .finish(prompt.promptId, {
            status: "failed",
            expectedRunId: runId,
            error: runtimeError(error),
          })
          .catch(() => undefined);
        if (failed) {
          this.options.onUpdated?.(failed);
          this.resolveCompletion(failed);
        }
      }
    } finally {
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
    for (const resolve of waiters) {
      resolve(prompt);
    }
  }

  private removeCompletionWaiter(
    promptId: string,
    resolve: (prompt: PromptSubmissionRecord) => void,
  ): void {
    const waiters = this.completionWaiters.get(promptId);
    if (!waiters) {
      return;
    }
    waiters.delete(resolve);
    if (waiters.size === 0) {
      this.completionWaiters.delete(promptId);
    }
  }
}
