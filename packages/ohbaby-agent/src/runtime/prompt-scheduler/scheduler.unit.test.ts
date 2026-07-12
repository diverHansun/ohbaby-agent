import { describe, expect, it, vi } from "vitest";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  InvalidPromptClientRequestIdError,
  PromptIdempotencyConflictError,
  PromptSubmissionNotFoundError,
} from "./errors.js";
import { WorkspacePromptScheduler } from "./scheduler.js";

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
