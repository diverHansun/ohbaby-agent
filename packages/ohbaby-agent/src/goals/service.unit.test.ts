import { describe, expect, it } from "vitest";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalService } from "./service.js";
import type { GoalExecutionInterruptInput, GoalTurnRunner } from "./types.js";

const noOpExecutionControl = {
  interruptGoalExecution: (): Promise<void> => Promise.resolve(),
};

function deferredRunner(): {
  runner: GoalTurnRunner;
  calls: string[];
  release: () => void;
} {
  const calls: string[] = [];
  let releaseFn: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return {
    calls,
    release: (): void => {
      releaseFn();
    },
    runner: {
      async runTurn(sessionId): Promise<{ readonly status: "cancelled" }> {
        calls.push(sessionId);
        await gate;
        return { status: "cancelled" };
      },
    },
  };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("GoalService", () => {
  it("captures all owned roots after tickets settle and preserves background work on an ordinary Stop", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (input): Promise<void> => {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
    });
    const goal = await service.createGoal("s1", {
      actor: "user",
      objective: "delegated work",
    });
    const epoch = service.currentExecutionEpoch("s1");
    for (const runId of ["goal-root-1", "goal-root-2"]) {
      const ticket = await service.admitTurnInBoundary(
        "s1",
        goal.goalId,
        epoch,
      );
      if (!ticket) throw new Error("Expected admission");
      service.bindTicketRun(ticket, runId);
      await service.settleTurn("s1", ticket, { status: "succeeded" });
    }
    expect(service.getOwnedRunIds(goal.goalId)).toEqual([
      "goal-root-1",
      "goal-root-2",
    ]);
    await service.pauseExecution(
      "s1",
      goal.goalId,
      epoch,
      "interrupted",
      "user",
    );
    expect(interruptions.at(-1)).toMatchObject({
      preserveBackground: true,
      goalId: goal.goalId,
    });
    await service.cancelGoal("s1");
    expect(interruptions.at(-1)).toMatchObject({
      rootRunIds: ["goal-root-1", "goal-root-2"],
      reason: "goal cancelled",
    });
    expect(interruptions.at(-1)?.preserveBackground).not.toBe(true);
    expect(service.getOwnedRunIds(goal.goalId)).toEqual([]);
  });
  it("does not lose a background wake while the previous driver is settling", async () => {
    let turns = 0;
    let wake = true;
    const service = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: noOpExecutionControl,
    });
    service.attachTurnRunner({
      runTurn: () =>
        Promise.resolve({ status: ++turns === 1 ? "succeeded" : "cancelled" }),
      shouldWaitForSubagents: () => {
        if (wake) {
          wake = false;
          service.notifyWorkAvailable("s1");
        }
        return Promise.resolve(true);
      },
    });
    await service.createGoal("s1", {
      actor: "user",
      objective: "wait for children",
    });
    await service.whenIdle();
    expect(turns).toBe(2);
    expect(service.peekSnapshot("s1")?.status).toBe("paused");
  });

  it("cleans only the replaced Goal's settled roots before starting its successor", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (input): Promise<void> => {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
    });
    const goal = await service.createGoal("s1", {
      actor: "user",
      objective: "old",
    });
    const ticket = await service.admitTurnInBoundary(
      "s1",
      goal.goalId,
      service.currentExecutionEpoch("s1"),
    );
    if (!ticket) throw new Error("Expected admission");
    service.bindTicketRun(ticket, "old-root");
    await service.settleTurn("s1", ticket, { status: "succeeded" });
    const next = await service.createGoal("s1", {
      actor: "user",
      objective: "new",
      replace: true,
    });
    expect(interruptions).toMatchObject([
      { goalId: goal.goalId, rootRunIds: ["old-root"] },
    ]);
    expect(service.getOwnedRunIds(goal.goalId)).toEqual([]);
    expect(service.getOwnedRunIds(next.goalId)).toEqual([]);
  });

  it.each(["turn-budget", "safety-cap", "time-budget"])(
    "keeps automatic wakes sealed after %s refuses an admission",
    async (limit) => {
      let now = 0;
      const service = new GoalService({
        persistence: new InMemoryGoalPersistence(),
        executionControl: noOpExecutionControl,
        safetyCapTurns: limit === "safety-cap" ? 1 : 10,
        now: (): number => now,
      });
      const goal = await service.createGoal("s1", {
        actor: "user",
        objective: "bounded",
        budgetLimits:
          limit === "turn-budget"
            ? { turnBudget: 1 }
            : limit === "time-budget"
              ? { wallClockBudgetMs: 100 }
              : {},
      });
      expect(service.isAutomaticRunBudgetExhausted("s1")).toBe(false);
      const epoch = service.currentExecutionEpoch("s1");
      const ticket = await service.admitTurnInBoundary(
        "s1",
        goal.goalId,
        epoch,
      );
      if (!ticket) throw new Error("Expected admission");
      await service.settleTurn("s1", ticket, { status: "succeeded" });
      if (limit === "time-budget") now = 100;
      expect(
        await service.admitTurnInBoundary("s1", goal.goalId, epoch),
      ).toBeNull();
      expect(service.peekSnapshot("s1")?.status).toBe("blocked");
      service.notifyWorkAvailable("s1");
      expect(service.isAutomaticRunBudgetExhausted("s1")).toBe(true);
      expect(service.isAutomaticRunBudgetExhausted("other")).toBe(false);
      service.dispose();
    },
  );

  it("preserves budget exhaustion facts while a user Stop leaves the Goal paused", async () => {
    const service = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: noOpExecutionControl,
      safetyCapTurns: 1,
    });
    const goal = await service.createGoal("s1", {
      actor: "user",
      objective: "bounded",
    });
    const epoch = service.currentExecutionEpoch("s1");
    const ticket = await service.admitTurnInBoundary("s1", goal.goalId, epoch);
    if (!ticket) throw new Error("Expected admission");
    await service.settleTurn("s1", ticket, { status: "cancelled" });
    await service.pauseExecution(
      "s1",
      goal.goalId,
      epoch,
      "interrupted",
      "user",
    );
    expect(service.peekSnapshot("s1")?.status).toBe("paused");
    expect(service.isAutomaticRunBudgetExhausted("s1")).toBe(true);
  });

  it("only normalizes on explicit initialization and reads live initialized state without replay", async () => {
    const persistence = new InMemoryGoalPersistence();
    const original = new GoalService({
      persistence,
      executionControl: noOpExecutionControl,
    });
    await original.createGoal("s1", { actor: "user", objective: "saved" });
    const service = new GoalService({
      persistence,
      executionControl: noOpExecutionControl,
    });
    const before = await persistence.list("s1");
    expect(service.peekSnapshot("s1")).toBeUndefined();
    expect(await persistence.list("s1")).toEqual(before);
    await Promise.all([service.initSession("s1"), service.initSession("s1")]);
    expect(service.peekSnapshot("s1")?.status).toBe("paused");
    expect((await persistence.list("s1")).length).toBe(before.length + 1);
    await service.resumeGoal("s1");
    await service.initSession("s1");
    expect(service.peekSnapshot("s1")?.status).toBe("active");
    await service.initSession("empty");
    expect(service.peekSnapshot("empty")).toBeNull();
  });
  it("awaits execution interruption when an active goal pauses", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });

    await service.pauseGoal("s1", "stop now");

    expect(interruptions).toMatchObject([
      { includePrimary: true, reason: "stop now", sessionId: "s1" },
    ]);
  });

  it("interrupts execution only once when an active goal is paused repeatedly", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });

    await service.pauseGoal("s1", "interrupted");
    await service.pauseGoal("s1", "Paused by user");

    expect(interruptions).toMatchObject([
      { includePrimary: true, reason: "interrupted", sessionId: "s1" },
    ]);
    expect(await service.getSnapshot("s1")).toMatchObject({
      pauseReason: "interrupted",
      status: "paused",
    });
  });

  it("does not interrupt paused-period work when cancelling a paused goal", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.pauseGoal("s1");
    interruptions.length = 0;

    await service.cancelGoal("s1");

    expect(interruptions).toEqual([]);
  });

  it("interrupts only straggling subagents when the model completes", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });

    await service.updateGoalFromModel("s1", "complete");

    expect(interruptions).toMatchObject([
      {
        includePrimary: false,
        reason: "goal completed",
        sessionId: "s1",
      },
    ]);
  });

  it("createGoal starts driving exactly once (ensureDriving idempotent)", async () => {
    const { calls, release, runner } = deferredRunner();
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
    });
    service.attachTurnRunner(runner);
    await service.createGoal("s1", { actor: "user", objective: "a" });
    service.ensureDriving("s1");
    service.ensureDriving("s1");
    await settle(10);
    expect(calls).toHaveLength(1);
    release();
    await service.whenIdle("s1");
  });

  it("resumeGoal rejects an exhausted safety cap", async () => {
    const outcomes: string[] = [];
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
      safetyCapTurns: 1,
    });
    service.attachTurnRunner({
      async runTurn(sessionId, goalId, epoch) {
        outcomes.push("turn");
        const ticket = await service.admitTurnInBoundary(
          sessionId,
          goalId,
          epoch,
        );
        return ticket === null
          ? { status: "not_admitted" as const }
          : { status: "succeeded" as const, ticket };
      },
      finishTurn: (sessionId, ticket, outcome) =>
        service.settleTurn(sessionId, ticket, outcome),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.whenIdle("s1");
    expect((await service.getSnapshot("s1"))?.status).toBe("blocked");
    await expect(service.resumeGoal("s1")).rejects.toThrow("Safety cap");
    await service.whenIdle("s1");
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks at safety cap without a session-wide interrupt after the goal turn settled", async () => {
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      persistence: new InMemoryGoalPersistence(),
      safetyCapTurns: 1,
    });
    service.attachTurnRunner({
      async runTurn(sessionId, goalId, epoch) {
        const ticket = await service.admitTurnInBoundary(
          sessionId,
          goalId,
          epoch,
        );
        return ticket === null
          ? { status: "not_admitted" as const }
          : { status: "succeeded" as const, ticket };
      },
      finishTurn: (sessionId, ticket, outcome) =>
        service.settleTurn(sessionId, ticket, outcome),
    });

    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.whenIdle("s1");

    expect(interruptions).toEqual([]);
    expect(service.peekSnapshot("s1")?.status).toBe("blocked");
  });

  it("updateGoalFromModel: active-on-paused does NOT resume (single resume path)", async () => {
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
    });
    service.attachTurnRunner({
      runTurn() {
        return Promise.resolve({ status: "cancelled" as const });
      },
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.whenIdle("s1");
    expect((await service.getSnapshot("s1"))?.status).toBe("paused");
    await expect(service.updateGoalFromModel("s1", "active")).rejects.toThrow(
      "complete or blocked",
    );
    expect(service.peekSnapshot("s1")?.status).toBe("paused");
  });

  it("updateGoalFromModel complete clears the goal", async () => {
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    const result = await service.updateGoalFromModel("s1", "complete");
    expect(result.snapshot).toBeNull();
    expect(await service.getSnapshot("s1")).toBeNull();
    await service.whenIdle("s1");
  });

  it("updateGoalFromModel ignores terminal updates after user pause", async () => {
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.pauseGoal("s1");

    const result = await service.updateGoalFromModel("s1", "complete");

    expect(result.snapshot?.status).toBe("paused");
    expect(result.note).toContain("/goal resume");
    expect((await service.getSnapshot("s1"))?.status).toBe("paused");
  });

  it("onChange fires for lifecycle transitions", async () => {
    const kinds: string[] = [];
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      onChange: (event): void => {
        kinds.push(event.change.kind);
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.pauseGoal("s1");
    expect(kinds).toContain("created");
    expect(kinds).toContain("lifecycle");
    await service.whenIdle("s1");
  });

  it("records model as the actor translating an explicit budget", async () => {
    const actors: (string | undefined)[] = [];
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      onChange: (event): void => {
        actors.push(event.change.actor);
      },
      persistence: new InMemoryGoalPersistence(),
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });

    await service.setBudget("s1", { wallClockBudgetMs: 1_000 });

    expect(actors.at(-1)).toBe("model");
  });

  it("without runner attached, createGoal still records goal (driving deferred)", async () => {
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
    });
    const snapshot = await service.createGoal("s1", {
      actor: "user",
      objective: "a",
    });
    expect(snapshot.status).toBe("active");
  });
});

it("rejects attempts to clear an active time budget through undefined", async () => {
  const persistence = new InMemoryGoalPersistence();
  const service = new GoalService({
    persistence,
    executionControl: noOpExecutionControl,
  });
  await service.createGoal("s", {
    actor: "user",
    objective: "work",
    budgetLimits: { wallClockBudgetMs: 10000 },
  });
  const before = await persistence.list("s");
  await expect(
    service.setBudget("s", { wallClockBudgetMs: undefined }),
  ).rejects.toThrow();
  expect(await persistence.list("s")).toEqual(before);
  service.dispose();
});
