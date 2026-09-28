import { describe, expect, it, vi } from "vitest";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  InvalidPromptClientRequestIdError,
  PromptIdempotencyConflictError,
  PromptSchedulerClosedError,
  PromptSubmissionNotFoundError,
  PromptWaitAbortedError,
} from "./errors.js";
import { WorkspacePromptScheduler } from "./scheduler.js";
import type { PromptExecutionResult } from "./types.js";
import {
  createDatabaseWriteBudget,
  getDatabaseWriteBudget,
  withDatabaseWriteBudget,
  type DatabaseWriteBudget,
} from "../../services/database/write-budget.js";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = (value): void => {
      done(value as T);
    };
  });
  return { promise, resolve };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs = 30,
): Promise<
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly error: unknown; readonly kind: "rejected" }
  | { readonly kind: "pending" }
> {
  return Promise.race([
    promise.then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ error, kind: "rejected" }) as const,
    ),
    new Promise<{ readonly kind: "pending" }>((resolve) => {
      setTimeout(() => {
        resolve({ kind: "pending" });
      }, timeoutMs);
    }),
  ]);
}

describe("WorkspacePromptScheduler", () => {
  it("includes queue, approval and tools and ends only after the final reply save", async () => {
    let now = 10;
    const firstGate = deferred();
    const approval = deferred();
    const tools = deferred();
    const finalSave = deferred();
    const started = deferred();
    const saving = deferred();
    const store = new InMemoryPromptSubmissionStore({ now: (): number => now });
    let savedText = "";
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "timing",
      store,
      execute: async (
        prompt,
        controls,
      ): Promise<import("./types.js").PromptExecutionResult> => {
        if (prompt.text === "first") {
          await firstGate.promise;
          return { status: "succeeded" };
        }
        await controls.markRunning("real-run");
        started.resolve();
        await approval.promise;
        await tools.promise;
        saving.resolve();
        await finalSave.promise;
        savedText = "final reply";
        return { status: "succeeded" };
      },
    });
    try {
      const first = await scheduler.accept({ sessionId: "s", text: "first" });
      now = 20;
      const queued = await scheduler.accept({ sessionId: "s", text: "second" });
      now = 100;
      firstGate.resolve();
      await scheduler.waitForCompletion(first.promptId);
      await started.promise;
      now = 200;
      approval.resolve();
      now = 300;
      tools.resolve();
      await saving.promise;
      const pending = await store.get(queued.promptId);
      expect(pending?.endedAt).toBeUndefined();
      expect(savedText).toBe("");
      now = 500;
      finalSave.resolve();
      const completed = await scheduler.waitForCompletion(queued.promptId);
      expect(savedText).toBe("final reply");
      expect(completed.createdAt).toBe(20);
      expect(completed.endedAt).toBe(500);
      if (completed.endedAt === undefined)
        throw new Error("Missing terminal timestamp");
      expect(completed.endedAt - completed.createdAt).toBe(480);
    } finally {
      firstGate.resolve();
      approval.resolve();
      tools.resolve();
      finalSave.resolve();
      scheduler.close();
    }
  });
  it("labels initialization rejection only before durable acceptance begins", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "safe-error",
      store,
      beforeSessionWrite: (): Promise<void> =>
        Promise.reject(new Error("seed failed")),
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      await expect(
        scheduler.accept({
          sessionId: "s",
          text: "hello",
          clientRequestId: "known-rejected",
        }),
      ).rejects.toMatchObject({
        code: "PROMPT_SUBMISSION_REJECTED",
        message: "seed failed",
      });
      expect(
        await store.getByClientRequestId("safe-error", "known-rejected"),
      ).toBeUndefined();
    } finally {
      scheduler.close();
    }
    const accept = store.accept.bind(store);
    vi.spyOn(store, "accept").mockImplementation(async (input) => {
      await accept(input);
      throw new Error("response lost after commit");
    });
    const uncertain = new WorkspacePromptScheduler({
      scopeKey: "safe-error",
      store,
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      const failure = await uncertain
        .accept({ sessionId: "s", text: "hello", clientRequestId: "unknown" })
        .catch((error: unknown) => error);
      expect(failure).not.toHaveProperty("code", "PROMPT_SUBMISSION_REJECTED");
      expect(
        await store.getByClientRequestId("safe-error", "unknown"),
      ).toBeDefined();
    } finally {
      uncertain.close();
    }
  });

  it("retries a failed seed on the next explicit write and shares concurrent initialization", async () => {
    const gate = deferred();
    let healthy = false;
    const seed = vi.fn(async () => {
      if (!healthy) throw new Error("transient seed");
      await gate.promise;
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "retry",
      store: new InMemoryPromptSubmissionStore(),
      beforeSessionWrite: seed,
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      await expect(
        scheduler.accept({ sessionId: "s", text: "first" }),
      ).rejects.toThrow("transient seed");
      healthy = true;
      const a = scheduler.accept({ sessionId: "s", text: "second" });
      const b = scheduler.accept({ sessionId: "s", text: "third" });
      void a.catch(() => undefined);
      void b.catch(() => undefined);
      await vi.waitFor(() => {
        expect(seed).toHaveBeenCalledTimes(2);
      });
      gate.resolve();
      const records = await Promise.all([a, b]);
      await Promise.all(
        records.map((record) => scheduler.waitForCompletion(record.promptId)),
      );
      expect(seed).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      scheduler.close();
    }
  });

  it("retries persisted queued work only after an explicit recovery entry", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      scopeKey: "retry",
      promptId: "queued",
      clientRequestId: "queued",
      sessionId: "s",
      text: "hello",
      userMessageId: "m",
      maxQueuedPrompts: 100,
    });
    const seed = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "retry",
      store,
      beforeSessionWrite: seed,
      busyRetryDelayMs: 10,
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      await scheduler.init();
      await vi.waitFor(() => {
        expect(scheduler.getRecoveryState("s").status).toBe("blocked");
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seed).toHaveBeenCalledTimes(1);
      expect((await store.get("queued"))?.status).toBe("queued");
      await scheduler.recoverSession("s");
      await vi.waitFor(async () => {
        expect((await store.get("queued"))?.status).toBe("succeeded");
      });
      expect(seed).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.close();
    }
  });

  it("cancels persisted queued work even while business initialization fails", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      scopeKey: "retry",
      promptId: "queued",
      clientRequestId: "queued",
      sessionId: "s",
      text: "hello",
      userMessageId: "m",
      maxQueuedPrompts: 100,
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "retry",
      store,
      beforeSessionWrite: (): Promise<void> =>
        Promise.reject(new Error("unavailable")),
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      expect((await scheduler.cancelQueued("queued")).status).toBe("cancelled");
      expect((await store.get("queued"))?.status).toBe("cancelled");
    } finally {
      scheduler.close();
    }
  });

  it("cancels a starting admission before it can create a run", async () => {
    const entered = deferred();
    const gate = deferred();
    const ran = vi.fn();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(_prompt, controls): Promise<{ status: "succeeded" }> {
        entered.resolve();
        await gate.promise;
        controls.signal.throwIfAborted();
        ran();
        return { status: "succeeded" };
      },
    });
    const prompt = await scheduler.accept({
      clientRequestId: "cancel-starting",
      sessionId: "session",
      text: "hello",
    });
    await entered.promise;
    expect((await scheduler.cancelQueued(prompt.promptId)).status).toBe(
      "cancelled",
    );
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ran).not.toHaveBeenCalled();
    expect((await scheduler.get(prompt.promptId))?.status).toBe("cancelled");
    scheduler.close();
  });

  it("returns the same accepted prompt for an idempotent retry without republishing", async () => {
    const gate = deferred();
    const onSubmitted = vi.fn();
    const scheduler = new WorkspacePromptScheduler({
      maxQueuedPrompts: 1,
      onSubmitted,
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const input = {
      clientRequestId: "request_1",
      sessionId: "session_1",
      text: "hello",
    } as const;
    const first = await scheduler.accept(input);
    const duplicate = await scheduler.accept(input);

    expect(duplicate.promptId).toBe(first.promptId);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    await expect(
      scheduler.accept({ ...input, text: "different" }),
    ).rejects.toBeInstanceOf(PromptIdempotencyConflictError);
    gate.resolve();
    await scheduler.waitForCompletion(first.promptId);
  });

  it("rejects reserved request ids and explicit-session idempotency conflicts", async () => {
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });

    await expect(
      scheduler.accept({
        clientRequestId: "legacy:prompt_old",
        sessionId: "session_1",
        text: "legacy collision",
      }),
    ).rejects.toBeInstanceOf(InvalidPromptClientRequestIdError);
    await scheduler.accept({
      clientRequestId: "request_explicit",
      expectedSessionId: "session_1",
      sessionId: () => Promise.resolve("session_1"),
      text: "same text",
    });
    await expect(
      scheduler.accept({
        clientRequestId: "request_explicit",
        expectedSessionId: "session_2",
        sessionId: () => Promise.resolve("session_2"),
        text: "same text",
      }),
    ).rejects.toBeInstanceOf(PromptIdempotencyConflictError);
  });

  it("does not lose a completion between the durable read and waiter setup", async () => {
    const release = deferred();
    const started = deferred();
    const store = new InMemoryPromptSubmissionStore();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store,
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await release.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "race",
    });
    await started.promise;

    const originalGet = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (promptId) => {
      const stale = await originalGet(promptId);
      release.resolve();
      await vi.waitFor(async () => {
        expect((await originalGet(promptId))?.status).toBe("succeeded");
      });
      return stale;
    });

    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("rejects waiting on an unknown prompt instead of hanging", async () => {
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });

    await expect(scheduler.waitForCompletion("missing")).rejects.toBeInstanceOf(
      PromptSubmissionNotFoundError,
    );
  });

  it("rejects existing and future waiters when closed", async () => {
    const gate = deferred();
    const started = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "close while waiting",
    });
    await started.promise;
    const existing = scheduler.waitForCompletion(accepted.promptId);

    scheduler.close();

    const existingOutcome = await settleWithin(existing);
    expect(existingOutcome).toMatchObject({ kind: "rejected" });
    if (existingOutcome.kind === "rejected") {
      expect(existingOutcome.error).toBeInstanceOf(PromptSchedulerClosedError);
    }
    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).rejects.toBeInstanceOf(PromptSchedulerClosedError);
    gate.resolve();
  });

  it("does not finish accepting after close wins an in-flight lookup", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    const originalLookup = store.getByClientRequestId.bind(store);
    vi.spyOn(store, "getByClientRequestId").mockImplementation(
      async (scopeKey, clientRequestId) => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return originalLookup(scopeKey, clientRequestId);
      },
    );
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const scheduler = new WorkspacePromptScheduler({
      execute,
      scopeKey: "/workspace",
      store,
    });

    const accepting = scheduler.accept({
      clientRequestId: "request_close_lookup",
      sessionId: "session_1",
      text: "close during lookup",
    });
    await lookupStarted.promise;
    scheduler.close();
    releaseLookup.resolve();

    await expect(accepting).rejects.toBeInstanceOf(PromptSchedulerClosedError);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      originalLookup("/workspace", "request_close_lookup"),
    ).resolves.toBeUndefined();
  });

  it("returns the receipt when close happens after durable acceptance", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const acceptCommitted = deferred();
    const releaseAccept = deferred();
    const originalAccept = store.accept.bind(store);
    vi.spyOn(store, "accept").mockImplementation(async (input) => {
      const accepted = await originalAccept(input);
      acceptCommitted.resolve();
      await releaseAccept.promise;
      return accepted;
    });
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const scheduler = new WorkspacePromptScheduler({
      execute,
      scopeKey: "/workspace",
      store,
    });

    const accepting = scheduler.accept({
      sessionId: "session_1",
      text: "durably accepted before close",
    });
    await acceptCommitted.promise;
    scheduler.close();
    releaseAccept.resolve();

    const accepted = await accepting;
    await expect(store.get(accepted.promptId)).resolves.toMatchObject({
      status: "queued",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the receipt when a scheduler fault happens after durable acceptance", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const firstStarted = deferred();
    const finishFirst = deferred();
    const secondCommitted = deferred();
    const releaseSecondAccept = deferred();
    const storageError = new Error("terminal storage unavailable");
    const originalAccept = store.accept.bind(store);
    vi.spyOn(store, "accept").mockImplementation(async (input) => {
      const accepted = await originalAccept(input);
      if (input.text === "accepted before fault") {
        secondCommitted.resolve();
        await releaseSecondAccept.promise;
      }
      return accepted;
    });
    vi.spyOn(store, "finish").mockRejectedValueOnce(storageError);
    const execute = vi.fn(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      return { status: "succeeded" as const };
    });
    const scheduler = new WorkspacePromptScheduler({
      execute,
      scopeKey: "/workspace",
      store,
    });
    const first = await scheduler.accept({
      sessionId: "session_1",
      text: "trigger scheduler fault",
    });
    await firstStarted.promise;

    const accepting = scheduler.accept({
      sessionId: "session_2",
      text: "accepted before fault",
    });
    await secondCommitted.promise;
    const firstCompletion = scheduler.waitForCompletion(first.promptId);
    finishFirst.resolve();
    await expect(firstCompletion).rejects.toBe(storageError);
    releaseSecondAccept.resolve();

    const accepted = await accepting;
    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.close();
  });

  it("does not claim queued work after close wins an in-flight queue read", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const listStarted = deferred();
    const releaseList = deferred();
    const originalList = store.listQueued.bind(store);
    vi.spyOn(store, "listQueued").mockImplementation(async (scopeKey) => {
      listStarted.resolve();
      await releaseList.promise;
      return originalList(scopeKey);
    });
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const scheduler = new WorkspacePromptScheduler({
      execute,
      scopeKey: "/workspace",
      store,
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "stay queued after close",
    });
    await listStarted.promise;

    scheduler.close();
    releaseList.resolve();

    await vi.waitFor(async () => {
      expect(await store.get(accepted.promptId)).toMatchObject({
        status: "queued",
      });
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requeues a claim when close wins the in-flight claim", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const claimFinished = deferred();
    const releaseClaim = deferred();
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementation(async (promptId) => {
      const claimed = await originalClaim(promptId);
      claimFinished.resolve();
      await releaseClaim.promise;
      return claimed;
    });
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const scheduler = new WorkspacePromptScheduler({
      execute,
      scopeKey: "/workspace",
      store,
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "requeue claimed work",
    });
    await claimFinished.promise;

    scheduler.close();
    releaseClaim.resolve();

    await vi.waitFor(async () => {
      expect(await store.get(accepted.promptId)).toMatchObject({
        status: "queued",
      });
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts only the selected waiter without cancelling the prompt", async () => {
    const gate = deferred();
    const started = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "abort one wait",
    });
    await started.promise;
    const controller = new AbortController();
    const aborted = scheduler.waitForCompletion(accepted.promptId, {
      signal: controller.signal,
    });
    const surviving = scheduler.waitForCompletion(accepted.promptId);

    controller.abort();

    const abortedOutcome = await settleWithin(aborted);
    expect(abortedOutcome).toMatchObject({ kind: "rejected" });
    if (abortedOutcome.kind === "rejected") {
      expect(abortedOutcome.error).toBeInstanceOf(PromptWaitAbortedError);
    }
    gate.resolve();
    await expect(surviving).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps the completed result when completion wins before wait abort and close", async () => {
    const gate = deferred();
    const started = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "three-way waiter race",
    });
    await started.promise;
    const controller = new AbortController();
    const waiting = scheduler.waitForCompletion(accepted.promptId, {
      signal: controller.signal,
    });

    gate.resolve();
    await expect(waiting).resolves.toMatchObject({ status: "succeeded" });
    controller.abort();
    scheduler.close();

    expect(scheduler.activeCount()).toBe(0);
    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).rejects.toBeInstanceOf(PromptSchedulerClosedError);
  });

  it("aborts only the waiter when wait abort wins before completion and close", async () => {
    const gate = deferred();
    const started = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "wait abort wins",
    });
    await started.promise;
    const controller = new AbortController();
    const waiting = scheduler.waitForCompletion(accepted.promptId, {
      signal: controller.signal,
    });

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(PromptWaitAbortedError);
    const surviving = scheduler.waitForCompletion(accepted.promptId);
    gate.resolve();

    await expect(surviving).resolves.toMatchObject({ status: "succeeded" });
    expect(scheduler.activeCount()).toBe(0);
    scheduler.close();
  });

  it("rejects pending and future waiters when close wins before abort and completion", async () => {
    const gate = deferred();
    const started = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(): Promise<{ status: "succeeded" }> {
        started.resolve();
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "scheduler close wins",
    });
    await started.promise;
    const controller = new AbortController();
    const waiting = scheduler.waitForCompletion(accepted.promptId, {
      signal: controller.signal,
    });

    scheduler.close();
    await expect(waiting).rejects.toBeInstanceOf(PromptSchedulerClosedError);
    controller.abort();
    gate.resolve();

    await vi.waitFor(() => {
      expect(scheduler.activeCount()).toBe(0);
    });
    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).rejects.toBeInstanceOf(PromptSchedulerClosedError);
  });

  it("blocks only the affected session on terminal persistence failure", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const storageError = new Error("terminal write unavailable");
    const finish = vi
      .spyOn(store, "finish")
      .mockRejectedValueOnce(storageError);
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store,
      execute: (): Promise<{ status: "succeeded" }> =>
        Promise.resolve({ status: "succeeded" }),
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "persist terminal",
    });

    const outcome = await settleWithin(
      scheduler.waitForCompletion(accepted.promptId),
    );

    expect(outcome).toEqual({ error: storageError, kind: "rejected" });
    expect(finish).toHaveBeenCalledOnce();
    const healthy = await scheduler.accept({
      sessionId: "session_2",
      text: "after fault",
    });
    expect(["succeeded", "failed"]).toContain(
      (await scheduler.waitForCompletion(healthy.promptId)).status,
    );
    await expect(scheduler.waitForCompletion(accepted.promptId)).rejects.toBe(
      storageError,
    );
  });

  it("retains an executor failure when its terminal persistence fails", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const storageError = new Error("failed terminal write unavailable");
    const finish = vi
      .spyOn(store, "finish")
      .mockRejectedValueOnce(storageError);
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store,
      execute: (): Promise<never> =>
        Promise.reject(new Error("provider failed")),
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "persist failed terminal",
    });

    const outcome = await settleWithin(
      scheduler.waitForCompletion(accepted.promptId),
    );

    expect(outcome).toEqual({ error: storageError, kind: "rejected" });
    expect(finish).toHaveBeenCalledOnce();
    const healthy = await scheduler.accept({
      sessionId: "session_2",
      text: "after fault",
    });
    expect(["succeeded", "failed"]).toContain(
      (await scheduler.waitForCompletion(healthy.promptId)).status,
    );
    await expect(scheduler.waitForCompletion(accepted.promptId)).rejects.toBe(
      storageError,
    );
  });

  it("preserves an interrupted executor result as a resolved business terminal", async () => {
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      execute: (): Promise<{
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly source: "runtime";
        };
        readonly status: "interrupted";
      }> =>
        Promise.resolve({
          error: {
            code: "PROCESS_INTERRUPTED",
            message: "process owner disappeared",
            retryable: true,
            source: "runtime" as const,
          },
          status: "interrupted" as const,
        }),
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "interrupt me",
    });

    const completion = await scheduler.waitForCompletion(accepted.promptId);
    expect(completion.status).toBe("interrupted");
    expect(completion.endedAt).toBeTypeOf("number");
    expect(completion.error).toMatchObject({
      code: "PROCESS_INTERRUPTED",
      source: "runtime",
    });
  });

  it("backs off a busy session without a hot retry loop", async () => {
    let attempts = 0;
    const firstAttempt = deferred();
    const scheduler = new WorkspacePromptScheduler({
      busyRetryDelayMs: 40,
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      isBusyError: (error): boolean =>
        error instanceof Error && error.message === "SESSION_BUSY",
      execute(): Promise<{ status: "succeeded" }> {
        attempts += 1;
        if (attempts === 1) {
          firstAttempt.resolve();
          return Promise.reject(new Error("SESSION_BUSY"));
        }
        return Promise.resolve({ status: "succeeded" });
      },
    });
    const accepted = await scheduler.accept({
      sessionId: "session_1",
      text: "retry",
    });
    await firstAttempt.promise;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(attempts).toBe(1);

    await expect(
      scheduler.waitForCompletion(accepted.promptId),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(attempts).toBe(2);
  });

  it("runs ten different sessions and keeps the eleventh queued", async () => {
    let now = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    const store = new InMemoryPromptSubmissionStore({
      now: (): number => ++now,
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store,
      createPromptId: (() => {
        let id = 0;
        return (): string => `prompt_${String(++id)}`;
      })(),
      createUserMessageId: (() => {
        let id = 0;
        return (): string => `message_${String(++id)}`;
      })(),
      async execute(prompt, controls): Promise<{ status: "succeeded" }> {
        started.push(prompt.sessionId);
        await controls.markRunning(`run_${prompt.sessionId}`);
        const gate = deferred();
        gates.set(prompt.sessionId, gate);
        await gate.promise;
        return { status: "succeeded" };
      },
    });

    const accepted = [];
    for (let index = 1; index <= 11; index += 1) {
      accepted.push(
        await scheduler.accept({
          sessionId: `session_${String(index)}`,
          text: `prompt ${String(index)}`,
        }),
      );
    }

    await vi.waitFor(() => {
      expect(started).toHaveLength(10);
      expect(scheduler.activeCount()).toBe(10);
    });
    expect(await store.get(accepted[10].promptId)).toMatchObject({
      status: "queued",
    });

    gates.get("session_1")?.resolve();
    await vi.waitFor(() => {
      expect(started).toContain("session_11");
      expect(scheduler.activeCount()).toBe(10);
    });

    for (const gate of gates.values()) {
      gate.resolve();
    }
    await Promise.all(
      accepted.map((prompt) => scheduler.waitForCompletion(prompt.promptId)),
    );
    expect(scheduler.activeCount()).toBe(0);
  });

  it("keeps one session FIFO and supports queued edit and cancel", async () => {
    let now = 0;
    const firstGate = deferred();
    const executed: string[] = [];
    const store = new InMemoryPromptSubmissionStore({
      now: (): number => ++now,
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store,
      async execute(prompt, controls): Promise<{ status: "succeeded" }> {
        executed.push(prompt.text);
        await controls.markRunning(`run_${prompt.promptId}`);
        if (executed.length === 1) {
          await firstGate.promise;
        }
        return { status: "succeeded" };
      },
    });

    const first = await scheduler.accept({ sessionId: "session_1", text: "A" });
    const second = await scheduler.accept({
      sessionId: "session_1",
      text: "B",
    });
    const third = await scheduler.accept({ sessionId: "session_1", text: "C" });

    await vi.waitFor(() => {
      expect(executed).toEqual(["A"]);
    });
    const lease = await scheduler.acquireEditLease(second.promptId, "client_1");
    const edited = await scheduler.commitEdit(
      second.promptId,
      lease.editLeaseId,
      "B edited",
    );
    const cancelled = await scheduler.cancelQueued(third.promptId);
    expect(edited.createdAt).toBe(second.createdAt);
    expect(cancelled.status).toBe("cancelled");

    firstGate.resolve();
    await scheduler.waitForCompletion(first.promptId);
    await scheduler.waitForCompletion(second.promptId);
    expect(executed).toEqual(["A", "B edited"]);
    expect(await store.get(third.promptId)).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not cross a leased lane head while other sessions continue", async () => {
    const firstGate = deferred();
    const executed: string[] = [];
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(prompt): Promise<{ status: "succeeded" }> {
        executed.push(prompt.text);
        if (prompt.text === "A") await firstGate.promise;
        return { status: "succeeded" };
      },
    });
    const a = await scheduler.accept({ sessionId: "session_1", text: "A" });
    const b = await scheduler.accept({ sessionId: "session_1", text: "B" });
    const c = await scheduler.accept({ sessionId: "session_1", text: "C" });
    const lease = await scheduler.acquireEditLease(b.promptId, "client_1");
    const d = await scheduler.accept({ sessionId: "session_2", text: "D" });

    await vi.waitFor(() => {
      expect(executed).toEqual(["A", "D"]);
    });
    firstGate.resolve();
    await scheduler.waitForCompletion(a.promptId);
    await scheduler.waitForCompletion(d.promptId);
    expect(executed).toEqual(["A", "D"]);

    await scheduler.releaseEditLease(b.promptId, lease.editLeaseId);
    await scheduler.waitForCompletion(b.promptId);
    await scheduler.waitForCompletion(c.promptId);
    expect(executed).toEqual(["A", "D", "B", "C"]);
  });

  it("automatically wakes a leased lane when its lease expires", async () => {
    const firstGate = deferred();
    const executed: string[] = [];
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "/workspace",
      store: new InMemoryPromptSubmissionStore(),
      async execute(prompt): Promise<{ status: "succeeded" }> {
        executed.push(prompt.text);
        if (prompt.text === "A") await firstGate.promise;
        return { status: "succeeded" };
      },
    });
    const a = await scheduler.accept({ sessionId: "session_1", text: "A" });
    const b = await scheduler.accept({ sessionId: "session_1", text: "B" });
    await scheduler.acquireEditLease(b.promptId, "client_1", 30);

    firstGate.resolve();
    await scheduler.waitForCompletion(a.promptId);
    await scheduler.waitForCompletion(b.promptId);

    expect(executed).toEqual(["A", "B"]);
  });
});

it("captures a lazy session preference once and rejects explicit conflicting replay", async () => {
  const store = new InMemoryPromptSubmissionStore();
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "scope",
    store,
    execute: (): Promise<{ status: "succeeded" }> =>
      Promise.resolve({ status: "succeeded" }),
  });
  let effort = "medium";
  const first = await scheduler.accept({
    clientRequestId: "reasoning-req",
    sessionId: "s",
    text: "hi",
    reasoning: () => Promise.resolve({ effort }),
  });
  effort = "high";
  const replay = await scheduler.accept({
    clientRequestId: "reasoning-req",
    sessionId: "s",
    text: "hi",
    reasoning: () => Promise.resolve({ effort }),
  });
  expect(replay.promptId).toBe(first.promptId);
  expect(replay.reasoning).toEqual({ effort: "medium" });
  await expect(
    scheduler.accept({
      clientRequestId: "reasoning-req",
      sessionId: "s",
      text: "hi",
      reasoning: { effort: "high" },
    }),
  ).rejects.toThrow(/conflict|different/i);
  scheduler.close();
});

describe("stopped prompt durability and recovery", () => {
  it("carries the Run terminal budget into prompt finish without wrapping model execution", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const originalFinish = store.finish.bind(store);
    let runBudget: DatabaseWriteBudget | undefined;
    const observed: (DatabaseWriteBudget | undefined)[] = [];
    vi.spyOn(store, "finish").mockImplementation((id, input) => {
      observed.push(getDatabaseWriteBudget());
      return originalFinish(id, input);
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "budget",
      store,
      execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
        expect(getDatabaseWriteBudget()).toBeUndefined();
        await controls.markRunning("run-a");
        runBudget = createDatabaseWriteBudget();
        return { status: "succeeded" };
      },
      withFinalizationWriteBudget<T>(
        runId: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        expect(runId).toBe("run-a");
        if (!runBudget) throw new Error("Missing Run terminal budget");
        return withDatabaseWriteBudget(runBudget, operation);
      },
    });
    try {
      const prompt = await scheduler.accept({ sessionId: "s", text: "A" });
      await scheduler.waitForCompletion(prompt.promptId);
      expect(observed).toEqual([runBudget]);
    } finally {
      scheduler.close();
    }
  });

  it("joins entry recovery during shutdown and shares its new budget through prompt finish", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const entered = deferred();
    const resume = deferred();
    const originalFailure = new Error("run terminal unavailable");
    const originalBudget = createDatabaseWriteBudget();
    const originalFinish = store.finish.bind(store);
    const observed: (DatabaseWriteBudget | undefined)[] = [];
    vi.spyOn(store, "finish").mockImplementation((id, input) => {
      observed.push(getDatabaseWriteBudget());
      return originalFinish(id, input);
    });
    const recoverExecution = vi.fn(async (): Promise<PromptExecutionResult> => {
      observed.push(getDatabaseWriteBudget());
      entered.resolve();
      await resume.promise;
      return {
        status: "interrupted",
        error: {
          code: "RUN_INTERRUPTED",
          message: "user-stop",
          source: "runtime",
          retryable: false,
        },
      };
    });
    const execute = vi.fn(
      async (
        _prompt,
        controls: import("./types.js").PromptExecutionControls,
      ) => {
        await controls.markRunning("run-a");
        throw originalFailure;
      },
    );
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "budget-recovery",
      store,
      execute,
      recoverExecution,
      isExecutionPersistenceError: (error): boolean =>
        error === originalFailure,
      withFinalizationWriteBudget<T>(
        _runId: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        return withDatabaseWriteBudget(
          getDatabaseWriteBudget() ?? originalBudget,
          operation,
        );
      },
    });
    try {
      const prompt = await scheduler.accept({ sessionId: "s", text: "A" });
      await expect(
        scheduler.waitForCompletion(prompt.promptId),
      ).rejects.toThrow(originalFailure);
      const entry = scheduler.recoverSession("s");
      await entered.promise;
      const shutdown = scheduler.settleShutdown();
      await new Promise<void>((resolve) => setImmediate(resolve));
      resume.resolve();
      await Promise.all([entry, shutdown]);
      expect(recoverExecution).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(observed).toHaveLength(2);
      expect(observed[0]).toBeDefined();
      expect(observed[0]).not.toBe(originalBudget);
      expect(observed[1]).toBe(observed[0]);
      expect(await store.get(prompt.promptId)).toMatchObject({
        status: "interrupted",
      });
      expect(scheduler.getRecoveryState("s").status).toBe("ready");
    } finally {
      resume.resolve();
      scheduler.close();
    }
  });

  it("retries only the retained terminal facts, merges recovery and claims the current queue once", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const mainExited = deferred();
    const running = deferred();
    const recoveryWrite = deferred();
    let writable = false;
    let recovering = false;
    const originalFinish = store.finish.bind(store);
    const finish = vi
      .spyOn(store, "finish")
      .mockImplementation(async (id, result) => {
        if (result.expectedRunId === "run-a") {
          if (!writable) throw new Error("stop terminal unavailable");
          if (recovering) await recoveryWrite.promise;
        }
        return originalFinish(id, result);
      });
    const executed: string[] = [];
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "recovery",
      store,
      execute: async (prompt, controls): Promise<PromptExecutionResult> => {
        executed.push(prompt.text);
        if (prompt.text === "A") {
          await controls.markRunning("run-a");
          running.resolve();
          await mainExited.promise;
          return {
            status: "interrupted",
            error: {
              code: "RUN_INTERRUPTED",
              message: "user-stop",
              source: "runtime",
              retryable: false,
            },
          };
        }
        return { status: "succeeded" };
      },
    });
    try {
      const a = await scheduler.accept({ sessionId: "s", text: "A" });
      await running.promise;
      const b = await scheduler.accept({ sessionId: "s", text: "B" });
      const c = await scheduler.accept({ sessionId: "s", text: "C" });
      const done = scheduler.waitForCompletion(a.promptId);
      mainExited.resolve();
      await expect(done).rejects.toThrow("stop terminal unavailable");
      expect(executed).toEqual(["A"]);
      await scheduler.listVisible();
      await scheduler.listForSession("s");
      expect(finish).toHaveBeenCalledTimes(1);
      await expect(
        scheduler.accept({
          sessionId: "s",
          text: "D",
          clientRequestId: "not-accepted",
        }),
      ).rejects.toThrow("stop terminal unavailable");
      expect(
        await store.getByClientRequestId("recovery", "not-accepted"),
      ).toBeUndefined();
      await scheduler.cancelQueued(b.promptId);
      writable = true;
      recovering = true;
      const one = scheduler.recoverSession("s");
      const two = scheduler.recoverSession("s");
      expect(executed).toEqual(["A"]);
      recoveryWrite.resolve();
      await Promise.all([one, two]);
      await scheduler.waitForCompletion(c.promptId);
      expect(executed).toEqual(["A", "C"]);
      expect(await store.get(a.promptId)).toMatchObject({
        status: "interrupted",
        runId: "run-a",
      });
      expect(await store.get(b.promptId)).toMatchObject({
        status: "cancelled",
      });
      expect(scheduler.getRecoveryState("s").status).toBe("ready");
    } finally {
      mainExited.resolve();
      recoveryWrite.resolve();
      scheduler.close();
    }
  });
});

describe("recovery review regressions", () => {
  it("yields while an entry recovery waits for I/O instead of spinning the queue", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await store.accept({
      scopeKey: "scope",
      sessionId: "s",
      promptId: "p",
      clientRequestId: "c",
      text: "queued",
      userMessageId: "u",
      maxQueuedPrompts: 10,
    });
    const originalList = store.listQueued.bind(store);
    let lists = 0;
    vi.spyOn(store, "listQueued").mockImplementation(async (scope) => {
      // Bound a broken microtask loop so the regression itself cannot hang Vitest.
      if (++lists === 100) scheduler.close();
      return originalList(scope);
    });
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const recoveryStarted = deferred();
    const recoveryFinished = deferred();
    const beforeExecution = vi.fn(async () => {
      recoveryStarted.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      recoveryFinished.resolve();
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "scope",
      store,
      execute,
      beforeExecution,
    });
    try {
      await scheduler.init();
      await recoveryStarted.promise;
      await recoveryFinished.promise;
      expect(beforeExecution).toHaveBeenCalledTimes(1);
      expect(lists).toBeLessThan(10);
    } finally {
      scheduler.close();
    }
  });

  it("preserves the observed prompt completion time when a failed finish is retried later", async () => {
    let now = 100;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new InMemoryPromptSubmissionStore({ now: (): number => now });
    const originalFinish = store.finish.bind(store);
    let writable = false;
    vi.spyOn(store, "finish").mockImplementation(async (promptId, input) => {
      if (!writable) throw new Error("terminal write failed");
      return originalFinish(promptId, input);
    });
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "scope",
      store,
      execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
        await controls.markRunning("run");
        return {
          status: "interrupted",
          error: {
            code: "RUN_INTERRUPTED",
            message: "user-stop",
            source: "runtime",
            retryable: false,
          },
        };
      },
    });
    try {
      const prompt = await scheduler.accept({ sessionId: "s", text: "A" });
      await expect(
        scheduler.waitForCompletion(prompt.promptId),
      ).rejects.toThrow("terminal write failed");
      now = 10_000;
      writable = true;
      await scheduler.recoverSession("s");
      expect(await store.get(prompt.promptId)).toMatchObject({
        status: "interrupted",
        endedAt: 100,
      });
    } finally {
      scheduler.close();
      clock.mockRestore();
    }
  });
});

it("rejects an admission still preparing when the preceding prompt becomes blocked", async () => {
  const store = new InMemoryPromptSubmissionStore();
  const main = deferred();
  const running = deferred();
  const reasoning = deferred();
  const preparing = deferred();
  vi.spyOn(store, "finish").mockRejectedValue(
    new Error("terminal write failed"),
  );
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "admission-race",
    store,
    execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
      await controls.markRunning("run-a");
      running.resolve();
      await main.promise;
      return { status: "succeeded" };
    },
  });
  try {
    const a = await scheduler.accept({ sessionId: "s", text: "A" });
    await running.promise;
    const admission = scheduler.accept({
      sessionId: "s",
      text: "D",
      clientRequestId: "never-accepted",
      reasoning: async () => {
        preparing.resolve();
        await reasoning.promise;
        return undefined;
      },
    });
    await preparing.promise;
    const completion = scheduler.waitForCompletion(a.promptId);
    main.resolve();
    await expect(completion).rejects.toThrow("terminal write failed");
    reasoning.resolve();
    await expect(admission).rejects.toMatchObject({
      code: "PROMPT_SUBMISSION_REJECTED",
    });
    expect(
      await store.getByClientRequestId("admission-race", "never-accepted"),
    ).toBeUndefined();
  } finally {
    main.resolve();
    reasoning.resolve();
    scheduler.close();
  }
});

it("keeps a retained prompt unchanged when finalization fails during its entry check", async () => {
  const store = new InMemoryPromptSubmissionStore();
  const main = deferred();
  const running = deferred();
  const recovery = deferred();
  const checking = deferred();
  let pauseRecovery = false;
  vi.spyOn(store, "finish").mockRejectedValue(
    new Error("terminal write failed"),
  );
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "resubmission-race",
    store,
    beforeExecution: async (): Promise<void> => {
      if (!pauseRecovery) return;
      checking.resolve();
      await recovery.promise;
    },
    execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
      await controls.markRunning("run-a");
      running.resolve();
      await main.promise;
      return { status: "succeeded" };
    },
  });
  try {
    const a = await scheduler.accept({ sessionId: "s", text: "A" });
    await running.promise;
    const retained = (
      await store.accept({
        promptId: "retained",
        clientRequestId: "retained",
        scopeKey: "resubmission-race",
        sessionId: "s",
        userMessageId: "retained-message",
        text: "original",
        maxQueuedPrompts: 100,
      })
    ).record;
    store.runtimeInputMemory.put({ ...retained, status: "retained" });
    const lease = await store.acquireEditLease("retained", "client", 60_000);
    const before = await store.get("retained");
    pauseRecovery = true;
    const resubmission = scheduler.resubmitRetained({
      promptId: "retained",
      operationId: "not-accepted",
      editLeaseId: lease.editLeaseId,
      ownerClientId: "client",
      text: "edited",
    });
    await checking.promise;
    const completion = scheduler.waitForCompletion(a.promptId);
    main.resolve();
    await expect(completion).rejects.toThrow("terminal write failed");
    recovery.resolve();
    await expect(resubmission).rejects.toThrow("terminal write failed");
    expect(await store.get("retained")).toEqual(before);
    expect(
      await store.getResubmissionReceipt("resubmission-race", "not-accepted"),
    ).toBeUndefined();
    expect(scheduler.getRecoveryState("s")).toMatchObject({
      status: "blocked",
    });
  } finally {
    main.resolve();
    recovery.resolve();
    scheduler.close();
  }
});

it("returns a committed resubmission receipt even when finalization later blocks the session", async () => {
  const store = new InMemoryPromptSubmissionStore();
  const main = deferred();
  const running = deferred();
  vi.spyOn(store, "finish").mockRejectedValue(
    new Error("terminal write failed"),
  );
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "resubmission-receipt",
    store,
    execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
      await controls.markRunning("run-a");
      running.resolve();
      await main.promise;
      return { status: "succeeded" };
    },
  });
  try {
    const a = await scheduler.accept({ sessionId: "s", text: "A" });
    await running.promise;
    const retained = (
      await store.accept({
        promptId: "retained",
        clientRequestId: "retained",
        scopeKey: "resubmission-receipt",
        sessionId: "s",
        userMessageId: "retained-message",
        text: "original",
        maxQueuedPrompts: 100,
      })
    ).record;
    store.runtimeInputMemory.put({ ...retained, status: "retained" });
    const lease = await store.acquireEditLease("retained", "client", 60_000);
    const input = {
      promptId: "retained",
      operationId: "accepted",
      editLeaseId: lease.editLeaseId,
      ownerClientId: "client",
      text: "edited",
    };
    const receipt = await scheduler.resubmitRetained(input);
    const completion = scheduler.waitForCompletion(a.promptId);
    main.resolve();
    await expect(completion).rejects.toThrow("terminal write failed");
    await expect(scheduler.resubmitRetained(input)).resolves.toEqual(receipt);
    expect(await store.get("retained")).toMatchObject({
      status: "queued",
      text: "edited",
    });
  } finally {
    main.resolve();
    scheduler.close();
  }
});

it("preserves a claimed B when its waiting goal owner fails, without adopting A's result or polling", async () => {
  const store = new InMemoryPromptSubmissionStore();
  const waiting = deferred();
  const release = deferred();
  const failure = new Error("goal A terminal unavailable");
  const recoverWrongRun = vi.fn(
    (): Promise<PromptExecutionResult> =>
      Promise.resolve({ status: "succeeded" }),
  );
  const repairGoal = vi.fn((): Promise<void> => Promise.resolve());
  let calls = 0;
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "goal-waiter",
    store,
    isExecutionPersistenceError: (error): boolean => error === failure,
    recoverExecution: recoverWrongRun,
    execute: async (_prompt, controls): Promise<PromptExecutionResult> => {
      calls++;
      if (calls === 1) {
        waiting.resolve();
        await release.promise;
        throw failure;
      }
      await controls.markRunning("run-b");
      return { status: "succeeded" };
    },
  });
  try {
    const b = await scheduler.accept({ sessionId: "s", text: "B" });
    await waiting.promise;
    scheduler.blockExecutionFinalization("s", failure, repairGoal);
    release.resolve();
    await vi.waitFor(async () => {
      expect(await store.get(b.promptId)).toMatchObject({ status: "queued" });
    });
    expect(scheduler.getRecoveryState("s")).toMatchObject({
      status: "blocked",
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    expect(repairGoal).not.toHaveBeenCalled();
    expect(recoverWrongRun).not.toHaveBeenCalled();
    vi.useRealTimers();
    await Promise.all([
      scheduler.recoverSession("s"),
      scheduler.recoverSession("s"),
    ]);
    expect(await scheduler.waitForCompletion(b.promptId)).toMatchObject({
      status: "succeeded",
      runId: "run-b",
    });
    expect(repairGoal).toHaveBeenCalledTimes(1);
    expect(recoverWrongRun).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
    release.resolve();
    scheduler.close();
  }
});
