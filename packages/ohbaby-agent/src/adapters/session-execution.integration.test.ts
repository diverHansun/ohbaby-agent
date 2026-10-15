import { describe, expect, it, vi } from "vitest";
import { SessionExecutionGate } from "./session-execution.js";
import { SessionViewOwner } from "./ui-state/session-view.js";
import { InMemoryPromptSubmissionStore } from "../runtime/prompt-scheduler/in-memory-store.js";
import type { PromptExecutionResult } from "../runtime/prompt-scheduler/types.js";
import { WorkspacePromptScheduler } from "../runtime/prompt-scheduler/scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("session execution admission", () => {
  it("keeps a busy goal lane queued without consuming user execution capacity and wakes on release", async () => {
    const store = new InMemoryPromptSubmissionStore();
    const gate = new SessionExecutionGate();
    const token = Symbol("goal");
    gate.reserve("goal", token);
    let subscriptions = 0;
    const subscribe = gate.subscribe.bind(gate);
    vi.spyOn(gate, "subscribe").mockImplementation((sessionId, wake) => {
      subscriptions++;
      const unsubscribe = subscribe(sessionId, wake);
      return (): void => {
        subscriptions--;
        unsubscribe();
      };
    });
    const started: string[] = [];
    const otherStarted = deferred();
    const otherFinish = deferred();
    const scheduler = new WorkspacePromptScheduler({
      scopeKey: "workspace",
      store,
      maxActiveSessions: 1,
      executionGate: gate,
      execute: async (prompt): Promise<PromptExecutionResult> => {
        started.push(prompt.sessionId);
        if (prompt.sessionId === "other") {
          otherStarted.resolve();
          await otherFinish.promise;
        }
        return { status: "succeeded" };
      },
    });
    try {
      const waiting = await scheduler.accept({
        sessionId: "goal",
        text: "queued user",
      });
      const other = await scheduler.accept({
        sessionId: "other",
        text: "other session",
      });
      await otherStarted.promise;
      expect((await store.get(waiting.record.promptId))?.status).toBe("queued");
      expect(started).toEqual(["other"]);
      otherFinish.resolve();
      await scheduler.waitForCompletion(other.record.promptId);
      gate.release(token);
      await scheduler.waitForCompletion(waiting.record.promptId);
      expect(started).toEqual(["other", "goal"]);
    } finally {
      otherFinish.resolve();
      scheduler.close();
    }
    expect(subscriptions).toBe(0);
  });
});

it("G23 rechecks ownership inside the shared commit queue after a stale empty prefilter", async () => {
  const gate = new SessionExecutionGate();
  const token = Symbol("goal");
  const owner = new SessionViewOwner({
    runtimeEpoch: "test",
    seed: (): Promise<never> => Promise.reject(new Error("unused view")),
    publish: (): void => undefined,
  });
  const store = new InMemoryPromptSubmissionStore();
  const checked = deferred();
  let armed = true;
  const isHeld = gate.isHeld.bind(gate);
  vi.spyOn(gate, "isHeld").mockImplementation((sessionId) => {
    const held = isHeld(sessionId);
    if (armed) {
      armed = false;
      void owner.runControl(sessionId, () => {
        gate.reserve(sessionId, token);
        return Promise.resolve();
      });
    } else if (held) checked.resolve();
    return held;
  });
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "test",
    store,
    executionGate: gate,
    commitCoordinator: {
      run: <T>(sid: string, op: () => Promise<T>): Promise<T> =>
        owner.runControl(sid, op),
    },
    execute: (): Promise<PromptExecutionResult> =>
      Promise.resolve({ status: "succeeded" }),
  });
  try {
    const queued = await scheduler.accept({ sessionId: "one", text: "user" });
    await checked.promise;
    expect((await store.get(queued.record.promptId))?.status).toBe("queued");
    gate.release(token);
    await scheduler.waitForCompletion(queued.record.promptId);
    expect(gate.isHeld("one")).toBe(false);
  } finally {
    scheduler.close();
  }
});

it("G4 releases the claim lease if shutdown wins before executor handoff", async () => {
  const gate = new SessionExecutionGate();
  const claimed = deferred();
  const releaseClaim = deferred();
  const requeued = deferred();
  const store = new InMemoryPromptSubmissionStore();
  const claim = store.claim.bind(store);
  const requeue = store.requeueBusy.bind(store);
  store.claim = async (id): ReturnType<typeof claim> => {
    const record = await claim(id);
    claimed.resolve();
    await releaseClaim.promise;
    return record;
  };
  store.requeueBusy = async (id): ReturnType<typeof requeue> => {
    const result = await requeue(id);
    requeued.resolve();
    return result;
  };
  const scheduler = new WorkspacePromptScheduler({
    scopeKey: "test",
    store,
    executionGate: gate,
    execute: (): Promise<never> =>
      Promise.reject(new Error("must not execute")),
  });
  const queued = await scheduler.accept({ sessionId: "one", text: "user" });
  await claimed.promise;
  scheduler.close();
  releaseClaim.resolve();
  await requeued.promise;
  await vi.waitFor(() => {
    expect(gate.isHeld("one")).toBe(false);
  });
  expect((await store.get(queued.record.promptId))?.status).toBe("queued");
  const next = Symbol("next");
  expect(gate.reserve("one", next)).toBe(true);
  gate.release(Symbol("stale"));
  expect(gate.isHeld("one")).toBe(true);
  gate.release(next);
});

it("G4 can reclaim queued work after the former scheduler closes", async () => {
  const gate = new SessionExecutionGate();
  const store = new InMemoryPromptSubmissionStore();
  const claimed = deferred();
  const releaseClaim = deferred();
  const requeued = deferred();
  const claim = store.claim.bind(store);
  const requeue = store.requeueBusy.bind(store);
  store.claim = async (id): ReturnType<typeof claim> => {
    const result = await claim(id);
    claimed.resolve();
    await releaseClaim.promise;
    return result;
  };
  store.requeueBusy = async (id): ReturnType<typeof requeue> => {
    const result = await requeue(id);
    requeued.resolve();
    return result;
  };
  const release = vi.spyOn(gate, "release");
  const old = new WorkspacePromptScheduler({
    scopeKey: "test",
    store,
    executionGate: gate,
    execute: (): Promise<never> => Promise.reject(new Error("closed executor")),
  });
  const queued = await old.accept({ sessionId: "one", text: "user" });
  await claimed.promise;
  old.close();
  releaseClaim.resolve();
  await requeued.promise;
  await vi.waitFor(() => {
    expect(release).toHaveBeenCalledTimes(1);
  });
  const next = new WorkspacePromptScheduler({
    scopeKey: "test",
    store,
    executionGate: gate,
    execute: (): Promise<PromptExecutionResult> =>
      Promise.resolve({ status: "succeeded" }),
  });
  try {
    await next.init();
    await next.waitForCompletion(queued.record.promptId);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(2);
    });
    expect(gate.isHeld("one")).toBe(false);
  } finally {
    next.close();
  }
});
