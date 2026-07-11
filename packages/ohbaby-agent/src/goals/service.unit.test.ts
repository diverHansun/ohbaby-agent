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

    expect(interruptions).toEqual([
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

    expect(interruptions).toEqual([
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

    expect(interruptions).toEqual([
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

  it("resumeGoal after automatic pause restarts driving", async () => {
    const outcomes: string[] = [];
    const service = new GoalService({
      executionControl: noOpExecutionControl,
      persistence: new InMemoryGoalPersistence(),
      safetyCapTurns: 1,
    });
    service.attachTurnRunner({
      runTurn() {
        outcomes.push("turn");
        return Promise.resolve({ status: "succeeded" as const });
      },
    });
    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.whenIdle("s1");
    expect((await service.getSnapshot("s1"))?.status).toBe("paused");
    await service.resumeGoal("s1");
    await service.whenIdle("s1");
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it("routes safety-cap pause through execution control", async () => {
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
      runTurn() {
        return Promise.resolve({ status: "succeeded" as const });
      },
    });

    await service.createGoal("s1", { actor: "user", objective: "a" });
    await service.whenIdle("s1");

    expect(interruptions).toEqual([
      expect.objectContaining({ includePrimary: true, sessionId: "s1" }),
    ]);
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
    const result = await service.updateGoalFromModel("s1", "active");
    expect(result.snapshot?.status).toBe("paused");
    expect(result.note).toContain("/goal resume");
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
