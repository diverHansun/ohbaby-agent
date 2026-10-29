import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySubagentExecutionStore,
  type SubagentExecutionRecord,
} from "./execution-store.js";
import type { ExecutionFactView } from "./execution-facts.js";
import {
  createSessionSubagentSupervisor,
  type SessionSubagentSupervisor,
} from "./session-supervisor.js";

const MINUTE = 60_000;
interface Fixture {
  executions: InMemorySubagentExecutionStore;
  supervisor: SessionSubagentSupervisor;
  wakes: { reason: string; at: number }[];
  start(
    id?: string,
    mode?: "background" | "foreground",
  ): Promise<SubagentExecutionRecord>;
  becomeIdle(interrupted?: boolean): void;
  active(source: "user" | "result" | "supervision"): void;
  setPermissions(ids: string[]): void;
  setBarrier(value?: Promise<void>): void;
  setWakeBarrier(value?: Promise<void>): void;
  setAfterActivation(value?: Promise<void>): void;
  setAcceptWake(value: boolean): void;
  setExecutionEvents(value: boolean): void;
}
function fixture(): Fixture {
  const executions = new InMemorySubagentExecutionStore();
  const wakes: { reason: string; at: number }[] = [];
  let emitEvents = true;
  const subscribe = executions.subscribe.bind(executions);
  vi.spyOn(executions, "subscribe").mockImplementation((listener) =>
    subscribe((record) => {
      if (emitEvents) listener(record);
    }),
  );
  let idle = false;
  let acceptWake = true;
  let permissions: string[] = [];
  let barrier: Promise<void> | undefined;
  let wakeBarrier: Promise<void> | undefined;
  let afterActivation: Promise<void> | undefined;
  let activity = 0;
  const supervisor = createSessionSubagentSupervisor({
    executions,
    isIdle: () => idle,
    collectFacts: async (record): Promise<ExecutionFactView> => {
      if (barrier) await barrier;
      return {
        executionId: record.executionId,
        subagentId: record.subagentId,
        status: record.status,
        phase: "tool",
        collectedAt: Date.now(),
        lastActivityAt: ++activity,
        currentTools: [
          {
            callId: `tool-${String(activity)}`,
            name: "read",
            phase: "executing",
          },
        ],
        recentTools: [],
        omittedTools: 0,
        approval: {
          blocked: permissions.length > 0,
          permissionIds: [...permissions],
        },
      };
    },
    wake: async (sessionId, reason, snapshot) => {
      if (wakeBarrier) await wakeBarrier;
      if (!acceptWake || snapshot.signal.aborted) return false;
      if (reason === "result")
        for (const record of snapshot.executions) {
          if (
            record.delivery.state === "pending" ||
            record.delivery.state === "delivered"
          )
            await executions.claimWakeup(record, Date.now());
        }
      wakes.push({ reason, at: Date.now() });
      idle = false;
      supervisor.active(sessionId, reason);
      if (afterActivation) await afterActivation;
      return true;
    },
  });
  supervisor.observe("parent");
  async function start(
    id = "child",
    mode: "background" | "foreground" = "background",
  ): Promise<SubagentExecutionRecord> {
    const accepted = await executions.accept({
      executionId: id,
      requestId: id,
      parentSessionId: "parent",
      requesterScopeId: "primary",
      requesterRunId: "root",
      rootSessionId: "parent",
      rootRunId: "root",
      subagentId: id,
      mode,
      prompt: "task",
      createdAt: Date.now(),
    });
    await executions.bindChild(
      accepted.record,
      { sessionId: `s-${id}`, contextScopeId: id },
      Date.now(),
    );
    const record = await executions.start(
      accepted.record,
      `run-${id}`,
      Date.now(),
    );
    await vi.advanceTimersByTimeAsync(0);
    return record;
  }
  function becomeIdle(interrupted = false): void {
    idle = true;
    supervisor.idle("parent", { interrupted });
  }
  function active(source: "user" | "result" | "supervision"): void {
    idle = false;
    supervisor.active("parent", source);
  }
  return {
    executions,
    supervisor,
    wakes,
    start,
    becomeIdle,
    active,
    setPermissions(ids: string[]): void {
      permissions = ids;
      supervisor.notify("parent");
    },
    setBarrier(value?: Promise<void>): void {
      barrier = value;
    },
    setWakeBarrier(value?: Promise<void>): void {
      wakeBarrier = value;
    },
    setAfterActivation(value?: Promise<void>): void {
      afterActivation = value;
    },
    setExecutionEvents(value): void {
      emitEvents = value;
    },
    setAcceptWake(value: boolean): void {
      acceptWake = value;
    },
  };
}
async function retryFixture(
  failures: number,
  claimBeforeError = false,
  notifyBeforeError = false,
): Promise<{
  supervisor: SessionSubagentSupervisor;
  executions: InMemorySubagentExecutionStore;
  record: SubagentExecutionRecord;
  attempts: number[];
  errors: ReturnType<typeof vi.fn>;
}> {
  const executions = new InMemorySubagentExecutionStore();
  const { record } = await executions.accept({
    executionId: "last-child",
    requestId: "last-call",
    parentSessionId: "parent",
    rootSessionId: "parent",
    requesterScopeId: "primary",
    requesterRunId: "main",
    rootRunId: "main",
    subagentId: "child",
    mode: "background",
    prompt: "task",
    createdAt: Date.now(),
  });
  await executions.finish(record, {
    status: "completed",
    output: "saved result",
    completedAt: Date.now(),
  });
  const attempts: number[] = [];
  const errors = vi.fn();
  const supervisor = createSessionSubagentSupervisor({
    executions,
    isIdle: () => true,
    collectFacts: () =>
      Promise.reject(new Error("No running executions should be inspected")),
    wake: async () => {
      attempts.push(Date.now());
      if (attempts.length <= failures) {
        if (claimBeforeError) await executions.claimWakeup(record, Date.now());
        if (notifyBeforeError) supervisor.notify("parent");
        throw new Error("transient pre-admission read failure");
      }
      await executions.claimWakeup(record, Date.now());
      return true;
    },
    onError: errors,
  });
  supervisor.observe("parent");
  await vi.advanceTimersByTimeAsync(0);
  return { supervisor, executions, record, attempts, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("session subagent supervision", () => {
  it("retries an unclaimed final result after a transient pre-admission failure without scanning idle history forever", async () => {
    const f = await retryFixture(1);
    try {
      expect(f.attempts).toHaveLength(1);
      expect(
        (await f.executions.get(f.record))?.delivery.wakeupAttemptedAt,
      ).toBeUndefined();
      f.supervisor.notify("parent");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.attempts).toHaveLength(2);
      expect(
        (await f.executions.get(f.record))?.delivery.wakeupAttemptedAt,
      ).toBeDefined();
      expect(f.errors).toHaveBeenCalledTimes(1);
      const reads = vi.spyOn(f.executions, "list");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.attempts).toHaveLength(2);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      f.supervisor.dispose();
    }
  });

  it.each([false, true])(
    "backs off and stops after three failed retries, including synchronous gate notifications (%s)",
    async (notifyBeforeError) => {
      const f = await retryFixture(Infinity, false, notifyBeforeError);
      try {
        const start = f.attempts[0];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.attempts.map((at) => at - start)).toEqual([
          0, 5_000, 15_000, 35_000,
        ]);
        const reads = vi.spyOn(f.executions, "list");
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(reads).not.toHaveBeenCalled();
        expect(f.errors).toHaveBeenCalledTimes(4);
      } finally {
        f.supervisor.dispose();
      }
    },
  );

  it("does not launch another model round for a result already claimed before an error", async () => {
    const f = await retryFixture(1, true);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.attempts).toHaveLength(1);
      expect(
        (await f.executions.get(f.record))?.delivery.wakeupAttemptedAt,
      ).toBeDefined();
    } finally {
      f.supervisor.dispose();
    }
  });

  it("starts its first deadline at real idle and uses five minutes after supervision", async () => {
    const f = fixture();
    try {
      await f.start();
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.wakes).toEqual([]);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
      expect(f.wakes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.wakes).toEqual([{ reason: "supervision", at: 22 * MINUTE }]);
      await vi.advanceTimersByTimeAsync(MINUTE);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
      expect(f.wakes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.wakes[1]).toEqual({ reason: "supervision", at: 28 * MINUTE });
    } finally {
      f.supervisor.dispose();
    }
  });
  it("ignores tool progress and stops after unchanged reviews at minutes two, seven and twelve", async () => {
    const f = fixture();
    try {
      await f.start();
      f.becomeIdle();
      for (const interval of [2, 5, 5]) {
        await vi.advanceTimersByTimeAsync(interval * MINUTE);
        f.becomeIdle();
      }
      expect(f.wakes.map((wake) => wake.at)).toEqual([
        2 * MINUTE,
        7 * MINUTE,
        12 * MINUTE,
      ]);
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(f.wakes).toHaveLength(3);
      await f.start("new-child");
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(4);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("suppresses timer wakeups after Stop but accepts a later result and restarts normal idle timing", async () => {
    const f = fixture();
    try {
      const first = await f.start();
      await f.start("still-running");
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(MINUTE);
      f.becomeIdle(true);
      f.setPermissions(["new-approval"]);
      await f.start("new-after-stop");
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(f.wakes).toEqual([]);
      await f.executions.finish(first, {
        status: "completed",
        output: "done",
        completedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.wakes.map((wake) => wake.reason)).toEqual(["result"]);
      f.setPermissions([]);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes.map((wake) => wake.reason)).toEqual([
        "result",
        "supervision",
      ]);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("invalidates a due timer while its fact collection is still pending", async () => {
    const f = fixture();
    let release!: () => void;
    try {
      await f.start();
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
      f.setBarrier(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await vi.advanceTimersByTimeAsync(1);
      f.becomeIdle(true);
      release();
      f.setBarrier();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.wakes).toEqual([]);
      f.active("user");
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(1);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("does not repeatedly review the same all-approval-blocked snapshot", async () => {
    const f = fixture();
    try {
      await f.start();
      f.setPermissions(["approval-1"]);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(1);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.wakes).toHaveLength(1);
      f.setPermissions(["approval-2"]);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(2);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("does not claim a result when the shared execution gate rejects its wakeup", async () => {
    const f = fixture();
    try {
      const record = await f.start();
      f.becomeIdle(true);
      f.setAcceptWake(false);
      await f.executions.finish(record, {
        status: "timed_out",
        completedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.wakes).toEqual([]);
      expect(
        (await f.executions.get(record))?.delivery.wakeupAttemptedAt,
      ).toBeUndefined();
      f.setAcceptWake(true);
      f.supervisor.notify("parent");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.wakes.map((wake) => wake.reason)).toEqual(["result"]);
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.wakes).toHaveLength(1);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("aborts a supervision wake waiting at the shared gate when the user presses Stop", async () => {
    const f = fixture();
    let release!: () => void;
    try {
      await f.start();
      f.becomeIdle();
      f.setWakeBarrier(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      f.becomeIdle(true);
      release();
      f.setWakeBarrier();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.wakes).toEqual([]);
      f.active("user");
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(1);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("does not let late supervision acceptance overwrite a newer user turn's idle deadline", async () => {
    const f = fixture();
    let release!: () => void;
    try {
      await f.start();
      f.becomeIdle();
      f.setAfterActivation(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(1);
      f.active("user");
      f.becomeIdle();
      release();
      f.setAfterActivation();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes.map((wake) => wake.at)).toEqual([2 * MINUTE, 4 * MINUTE]);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("does not auto-retry a result already offered to a previous main run", async () => {
    const f = fixture();
    try {
      const record = await f.start();
      await f.executions.finish(record, {
        status: "completed",
        output: "retained",
        completedAt: Date.now(),
      });
      await f.executions.claimWakeup(record, Date.now());
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(f.wakes).toEqual([]);
      expect((await f.executions.get(record))?.delivery.state).toBe("pending");
    } finally {
      f.supervisor.dispose();
    }
  });
  it("does not let another main session's result trigger this session", async () => {
    const f = fixture();
    try {
      f.becomeIdle();
      const other = (
        await f.executions.accept({
          executionId: "other",
          requestId: "other",
          parentSessionId: "other-parent",
          requesterScopeId: "primary",
          requesterRunId: "root",
          rootSessionId: "other-parent",
          rootRunId: "root",
          subagentId: "other",
          mode: "background",
          prompt: "task",
          createdAt: 0,
        })
      ).record;
      await f.executions.finish(other, { status: "completed", completedAt: 0 });
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(f.wakes).toEqual([]);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("keeps foreground and explicitly interrupted work out of automatic wakeups", async () => {
    const f = fixture();
    try {
      const foreground = await f.start("front", "foreground");
      const background = await f.start();
      f.becomeIdle();
      await f.executions.finish(background, {
        status: "interrupted",
        completedAt: Date.now(),
      });
      await f.executions.finish(foreground, {
        status: "completed",
        completedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.wakes).toEqual([]);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("reconciles only sessions with live background work and stops after termination", async () => {
    const f = fixture();
    const reads = vi.spyOn(f.executions, "list");
    try {
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(0);
      const idleReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(idleReads);
      const record = await f.start();
      const activeReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads.mock.calls.length).toBeGreaterThan(activeReads);
      await f.executions.finish(record, {
        status: "interrupted",
        completedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);
      const endedReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(endedReads);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("reconciles a missing terminal notification while work was last known active", async () => {
    const f = fixture();
    try {
      const record = await f.start();
      f.becomeIdle();
      await vi.advanceTimersByTimeAsync(0);
      f.setExecutionEvents(false);
      await f.executions.finish(record, {
        status: "completed",
        output: "saved result",
        completedAt: Date.now(),
      });
      expect(f.wakes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.wakes).toMatchObject([{ reason: "result" }]);
    } finally {
      f.supervisor.dispose();
    }
  });

  it("forgets resolved approval identities instead of retaining every historical request", async () => {
    const f = fixture();
    try {
      await f.start();
      f.becomeIdle();
      f.setPermissions(["approval"]);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(1);
      f.becomeIdle();
      f.setPermissions([]);
      await vi.advanceTimersByTimeAsync(0);
      f.setPermissions(["approval"]);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.wakes).toHaveLength(2);
    } finally {
      f.supervisor.dispose();
    }
  });
  it("cancels supervision during main work and discards removed sessions and subscriptions", async () => {
    const f = fixture();
    await f.start();
    f.becomeIdle();
    await vi.advanceTimersByTimeAsync(MINUTE);
    f.active("user");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(f.wakes).toEqual([]);
    f.becomeIdle();
    f.supervisor.remove("parent");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(f.wakes).toEqual([]);
    f.supervisor.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await f.start("after-dispose");
    expect(f.wakes).toEqual([]);
  });
});
