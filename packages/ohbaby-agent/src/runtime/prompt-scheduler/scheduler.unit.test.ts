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

  it("faults on terminal persistence failure without retrying it as a business failure", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const storageError = new Error("terminal write unavailable");
    const finish = vi.spyOn(store, "finish").mockRejectedValue(storageError);
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
    await expect(
      scheduler.accept({ sessionId: "session_2", text: "after fault" }),
    ).rejects.toBe(storageError);
  });

  it("faults when persisting an executor failure also fails", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const storageError = new Error("failed terminal write unavailable");
    const finish = vi.spyOn(store, "finish").mockRejectedValue(storageError);
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
