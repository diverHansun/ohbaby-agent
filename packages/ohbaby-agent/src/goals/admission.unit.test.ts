import { describe, expect, it } from "vitest";
import { GoalService } from "./service.js";
import { InMemoryGoalPersistence } from "./persistence.js";

describe("goal admission identity", () => {
  it("counts only admitted turns and renders the committed snapshot", async () => {
    const service: GoalService = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    const objective = "检查城市天气 <台北> & 東京\n汇总结果并注明来源";
    const goal = await service.createGoal("s", {
      objective,
      actor: "user",
    });
    const epoch = service.currentExecutionEpoch("s");
    const ticket = await service.admitTurnInBoundary("s", goal.goalId, epoch);
    expect(ticket?.turnNumber).toBe(1);
    expect(ticket?.displayText).toBe(objective);
    expect(ticket?.modelText).toContain(
      "<untrusted_objective>\n检查城市天气 &lt;台北&gt; &amp; 東京\n汇总结果并注明来源\n</untrusted_objective>",
    );
    expect(ticket?.modelText).toContain("Progress: 1 continuation turns");
    await service.pauseGoal("s");
    expect(ticket?.controller.signal.aborted).toBe(true);
    await service.resumeGoal("s");
    expect(
      await service.admitTurnInBoundary("s", goal.goalId, epoch),
    ).toBeNull();
    expect(service.peekSnapshot("s")?.turnsUsed).toBe(1);
  });
  it("settles usage once after pause without reactivating the goal", async () => {
    const service: GoalService = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    const goal = await service.createGoal("s", {
      objective: "work",
      actor: "user",
    });
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    if (ticket === null) throw new Error("missing ticket");
    await service.pauseGoal("s");
    await service.settleTurn("s", ticket, {
      status: "succeeded",
      usage: { totalTokens: 12, usageComplete: true },
    });
    await service.settleTurn("s", ticket, {
      status: "succeeded",
      usage: { totalTokens: 12, usageComplete: true },
    });
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "paused",
      tokensUsed: 12,
    });
  });
});

describe("goal persistence ordering", () => {
  it("keeps the active clock intact when a pause append fails", async () => {
    const persistence = new InMemoryGoalPersistence();
    let now = 0;
    const service: GoalService = new GoalService({
      persistence,
      now: (): number => now,
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    await service.createGoal("s", { actor: "user", objective: "work" });
    const append = persistence.append.bind(persistence);
    persistence.append = (): Promise<void> => Promise.reject(new Error("disk"));
    now = 100;
    await expect(service.pauseGoal("s")).rejects.toThrow("disk");
    now = 200;
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "active",
      wallClockMs: 200,
    });
    persistence.append = append;
    await service.pauseGoal("s");
    expect(service.peekSnapshot("s")?.wallClockMs).toBe(200);
  });

  it("retains a complete goal until tail usage and clear both succeed", async () => {
    const persistence = new InMemoryGoalPersistence();
    const service: GoalService = new GoalService({
      persistence,
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    const goal = await service.createGoal("s", {
      actor: "user",
      objective: "work",
    });
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    if (ticket === null) throw new Error("missing ticket");
    await service.updateGoalFromModel("s", "complete");
    expect(service.peekSnapshot("s")?.status).toBe("complete");
    await expect(service.resumeGoal("s")).rejects.toThrow("complete");
    const append = persistence.append.bind(persistence);
    persistence.append = async (sessionId, record): Promise<void> => {
      if (record.type === "clear") throw new Error("clear failed");
      await append(sessionId, record);
    };
    const outcome = {
      status: "succeeded" as const,
      usage: { totalTokens: 7, cachedInputTokens: 3, usageComplete: true },
    };
    await expect(service.settleTurn("s", ticket, outcome)).rejects.toThrow(
      "clear failed",
    );
    expect(ticket.settled).toBe(true);
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "complete",
      tokensUsed: 7,
      cachedTokensUsed: 3,
    });
    persistence.append = append;
    await service.settleTurn("s", ticket, outcome);
    expect(service.peekSnapshot("s")).toBeNull();
    expect(
      (await persistence.list("s")).filter((record) => record.tokensUsed === 7),
    ).toHaveLength(1);
  });

  it("rejects stale model tools after an objective edit but still accounts for old usage", async () => {
    const service: GoalService = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
      resolveMutationContext: (
        sessionId,
        runId,
      ): import("./types.js").GoalMutationContext => {
        const ticket = service.getTicketForRun(sessionId, runId);
        return ticket === undefined
          ? { kind: "invalid" }
          : { kind: "goal", ticket };
      },
    });
    const goal = await service.createGoal("s", {
      actor: "user",
      objective: "work",
    });
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    if (ticket === null) throw new Error("missing ticket");
    service.bindTicketRun(ticket, "run");
    const epoch = service.currentExecutionEpoch("s");
    await service.replaceGoal("s", " work ");
    expect(service.currentExecutionEpoch("s")).toBe(epoch);
    await service.replaceGoal("s", "new work");
    expect(ticket.stopIntent).toBeUndefined();
    await expect(
      service.setBudget("s", { turnBudget: 4 }, "run"),
    ).rejects.toThrow("permission");
    await expect(
      service.setBudget("s", { turnBudget: 4 }, "unknown"),
    ).rejects.toThrow("permission");
    await service.settleTurn("s", ticket, {
      status: "succeeded",
      usage: { totalTokens: 3, usageComplete: false },
    });
    expect(service.peekSnapshot("s")).toMatchObject({
      objective: "new work",
      tokensUsed: 3,
      usageIncomplete: true,
      status: "active",
    });
  });

  it("preserves accurate zero cache usage for a newly created goal", async () => {
    const service: GoalService = new GoalService({
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    expect(
      await service.createGoal("s", { actor: "user", objective: "work" }),
    ).toMatchObject({ cachedTokensUsed: 0, usageIncomplete: false });
  });
});

it("does not restart a failed driver when persisting its automatic pause also fails", async () => {
  const persistence = new InMemoryGoalPersistence();
  const errors: unknown[] = [];
  const service: GoalService = new GoalService({
    persistence,
    onError: ({ error }): void => {
      errors.push(error);
    },
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
  });
  let calls = 0;
  service.attachTurnRunner({
    runTurn(): Promise<never> {
      calls += 1;
      persistence.append = (): Promise<void> =>
        Promise.reject(new Error("disk"));
      return Promise.reject(new Error("runtime"));
    },
  });
  await service.createGoal("s", { actor: "user", objective: "work" });
  service.ensureDriving("s");
  await service.whenIdle("s");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(1);
  expect(errors).toHaveLength(1);
  expect(service.peekSnapshot("s")?.status).toBe("active");
});

it("captures ordinary user tool targets before an initialized-store await", async () => {
  const service = new GoalService({
    persistence: new InMemoryGoalPersistence(),
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
    resolveMutationContext: (): import("./types.js").GoalMutationContext => ({
      kind: "user",
    }),
  });
  await service.createGoal("s", { actor: "user", objective: "old" });
  const store = await service.storeFor("s");
  const replacement = store.create({
    actor: "user",
    objective: "replacement",
    replace: true,
  });
  const pendingBudget = service.setBudget(
    "s",
    { turnBudget: 4 },
    "normal-user-run",
  );
  await replacement;
  await expect(pendingBudget).rejects.toThrow("permission");
  expect(service.peekSnapshot("s")?.budgetLimits).toEqual({});
});
