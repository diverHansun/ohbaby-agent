import { describe, expect, it, vi } from "vitest";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import type { PromptSubmissionRecord, PromptExecutionResult } from "./types.js";
import { WorkspacePromptScheduler } from "./scheduler.js";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(
  store: InMemoryPromptSubmissionStore,
  id: string,
  sessionId: string,
): Promise<PromptSubmissionRecord> {
  return (
    await store.accept({
      clientRequestId: id,
      promptId: id,
      sessionId,
      scopeKey: "workspace",
      text: id,
      userMessageId: `message_${id}`,
      maxQueuedPrompts: 100,
    })
  ).record;
}

describe("prompt recovery boundaries", () => {
  it("reads only active prompts and window associations without starting queued work", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await seed(store, "queued", "a");
    await seed(store, "history", "a");
    await store.claim("history");
    await store.markRunning("history", "run_history");
    await store.finish("history", { status: "succeeded" });
    await seed(store, "old", "a");
    await store.cancelQueued("old");
    await seed(store, "other", "b");
    const execute = vi.fn(() =>
      Promise.resolve({ status: "succeeded" as const }),
    );
    const beforeSessionWrite = vi.fn(() => Promise.resolve());
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      execute,
      beforeSessionWrite,
    });
    try {
      expect(
        (await scheduler.listForSession("a")).map((p) => p.promptId),
      ).toEqual(["queued"]);
      expect(
        (await scheduler.listForSession("a", { runIds: ["run_history"] }))
          .map((p) => p.promptId)
          .sort(),
      ).toEqual(["history", "queued"]);
      expect(
        (
          await scheduler.listForSession("a", {
            messageIds: ["message_old", "message_other"],
          })
        )
          .map((p) => p.promptId)
          .sort(),
      ).toEqual(["old", "queued"]);
      expect(await scheduler.getByClientRequestId("history")).toMatchObject({
        promptId: "history",
        status: "succeeded",
      });
      expect(await scheduler.getByClientRequestId("unknown")).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(beforeSessionWrite).not.toHaveBeenCalled();
      expect((await store.get("queued"))?.status).toBe("queued");
    } finally {
      scheduler.close();
    }
  });

  it("blocks first acceptance at the session seed while another session completes", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const blocked = gate();
    const entered = gate();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      async beforeSessionWrite(sessionId): Promise<void> {
        if (sessionId === "a") {
          entered.resolve();
          await blocked.promise;
        }
      },
      execute: (): Promise<PromptExecutionResult> =>
        Promise.resolve({ status: "succeeded" }),
    });
    const first = scheduler.accept({
      sessionId: "a",
      text: "first",
      clientRequestId: "first",
    });
    try {
      await entered.promise;
      expect(
        await store.getByClientRequestId("workspace", "first"),
      ).toBeUndefined();
      const second = await scheduler.accept({
        sessionId: "b",
        text: "second",
        clientRequestId: "second",
      });
      expect((await scheduler.waitForCompletion(second.promptId)).status).toBe(
        "succeeded",
      );
      blocked.resolve();
      expect(
        (await scheduler.waitForCompletion((await first).promptId)).status,
      ).toBe("succeeded");
    } finally {
      blocked.resolve();
      scheduler.close();
      await first.catch(() => undefined);
    }
  });

  it("seeds restored lanes independently before claim and starts without a query", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await seed(store, "a1", "a");
    await seed(store, "b1", "b");
    const blocked = gate();
    const entered = gate();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      async beforeSessionWrite(sessionId): Promise<void> {
        if (sessionId === "a") {
          entered.resolve();
          await blocked.promise;
        }
      },
      execute: (): Promise<PromptExecutionResult> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      await scheduler.init();
      await entered.promise;
      expect((await scheduler.waitForCompletion("b1")).status).toBe(
        "succeeded",
      );
      expect((await store.get("a1"))?.status).toBe("queued");
      blocked.resolve();
      expect((await scheduler.waitForCompletion("a1")).status).toBe(
        "succeeded",
      );
    } finally {
      blocked.resolve();
      scheduler.close();
    }
  });

  it("does not hold unrelated explicit admissions behind a session resolver", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const blocked = gate();
    const entered = gate();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      execute: (): Promise<PromptExecutionResult> =>
        Promise.resolve({ status: "succeeded" }),
    });
    const first = scheduler.accept({
      expectedSessionId: "a",
      clientRequestId: "a",
      text: "a",
      async sessionId(): Promise<string> {
        entered.resolve();
        await blocked.promise;
        return "a";
      },
    });
    try {
      await entered.promise;
      const second = await scheduler.accept({
        expectedSessionId: "b",
        sessionId: "b",
        clientRequestId: "b",
        text: "b",
      });
      expect((await scheduler.waitForCompletion(second.promptId)).status).toBe(
        "succeeded",
      );
      blocked.resolve();
      expect(
        (await scheduler.waitForCompletion((await first).promptId)).status,
      ).toBe("succeeded");
    } finally {
      blocked.resolve();
      scheduler.close();
      await first.catch(() => undefined);
    }
  });

  it("commits durable transitions and projection together without holding execution or losing receipts on observer failure", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const execution = gate();
    const entered = gate();
    const notifications: string[] = [];
    let committing: string | undefined;
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      commitCoordinator: {
        async run<T>(
          sessionId: string,
          operation: () => Promise<T>,
        ): Promise<T> {
          expect(committing).toBeUndefined();
          committing = sessionId;
          try {
            return await operation();
          } finally {
            committing = undefined;
          }
        },
      },
      onSubmitted(prompt): void {
        expect(committing).toBe(prompt.sessionId);
        notifications.push(prompt.status);
        throw new Error("projection failed");
      },
      onUpdated(prompt): void {
        expect(committing).toBe(prompt.sessionId);
        notifications.push(prompt.status);
      },
      async execute(_prompt, controls): Promise<PromptExecutionResult> {
        expect(committing).toBeUndefined();
        await controls.markRunning("run");
        entered.resolve();
        await execution.promise;
        return { status: "succeeded" };
      },
    });
    try {
      const accepted = await scheduler.accept({
        sessionId: "a",
        text: "hello",
        clientRequestId: "request",
      });
      await entered.promise;
      expect(committing).toBeUndefined();
      expect(await scheduler.getByClientRequestId("request")).toMatchObject({
        promptId: accepted.promptId,
        status: "running",
      });
      execution.resolve();
      expect(
        (await scheduler.waitForCompletion(accepted.promptId)).status,
      ).toBe("succeeded");
      expect(notifications).toEqual([
        "queued",
        "starting",
        "running",
        "succeeded",
      ]);
    } finally {
      execution.resolve();
      scheduler.close();
    }
  });

  it("leaves failed initialization queued while unrelated lanes continue", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await seed(store, "broken", "a");
    await seed(store, "healthy", "b");
    const failures: string[] = [];
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      beforeSessionWrite: (sessionId): Promise<void> =>
        sessionId === "a"
          ? Promise.reject(new Error("seed unavailable"))
          : Promise.resolve(),
      onSessionInitializationError: (_error, sessionId): void => {
        failures.push(sessionId);
      },
      execute: (): Promise<PromptExecutionResult> =>
        Promise.resolve({ status: "succeeded" }),
    });
    try {
      await scheduler.init();
      expect((await scheduler.waitForCompletion("healthy")).status).toBe(
        "succeeded",
      );
      expect((await store.get("broken"))?.status).toBe("queued");
      await expect(
        scheduler.accept({
          sessionId: "a",
          text: "another",
          clientRequestId: "another",
        }),
      ).rejects.toThrow("seed unavailable");
      expect(
        await store.getByClientRequestId("workspace", "another"),
      ).toBeUndefined();
      expect(failures).toEqual(["a", "a"]);
    } finally {
      scheduler.close();
    }
  });

  it("coordinates lease, edit, release and cancellation projections with committed records", async () => {
    const store = new InMemoryPromptSubmissionStore();
    await seed(store, "0-block", "a");
    await seed(store, "edit", "a");
    await seed(store, "cancel", "a");
    const execution = gate();
    const entered = gate();
    let inCommit = false;
    const committed: string[] = [];
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      async execute(): Promise<PromptExecutionResult> {
        entered.resolve();
        await execution.promise;
        return { status: "succeeded" };
      },
      commitCoordinator: {
        async run<T>(_sessionId: string, work: () => Promise<T>): Promise<T> {
          inCommit = true;
          try {
            return await work();
          } finally {
            inCommit = false;
          }
        },
      },
      onUpdated(prompt): void {
        if (!inCommit) throw new Error("outside commit");
        committed.push(`${prompt.promptId}:${prompt.text}:${prompt.status}`);
      },
    });
    try {
      await scheduler.init();
      await entered.promise;
      const first = await scheduler.acquireEditLease("edit", "client");
      await scheduler.renewEditLease("edit", first.editLeaseId, "client");
      await scheduler.releaseEditLease("edit", first.editLeaseId, "client");
      const second = await scheduler.acquireEditLease("edit", "client");
      await scheduler.commitEdit(
        "edit",
        second.editLeaseId,
        "edited",
        "client",
      );
      await scheduler.cancelQueued("cancel");
      expect(committed).toContain("edit:edited:queued");
      expect(committed).toContain("cancel:cancel:cancelled");
      expect(committed.filter((item) => item.startsWith("edit:"))).toHaveLength(
        5,
      );
    } finally {
      scheduler.close();
      execution.resolve();
    }
  });
});
