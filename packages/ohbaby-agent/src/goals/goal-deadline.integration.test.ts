import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalService } from "./service.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import type { GoalExecutionInterruptInput } from "./types.js";

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
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
  return { service, interruptions };
}
afterEach(() => vi.useRealTimers());

describe("active goal deadlines", () => {
  it("blocks a long current run at its deadline and cancels preparation by captured ticket", async () => {
    const { service, interruptions } = setup();
    const goal = await service.createGoal("s", {
      actor: "user",
      objective: "long work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "blocked",
      turnsUsed: 1,
      wallClockMs: 1000,
    });
    expect(ticket?.controller.signal.aborted).toBe(true);
    expect(interruptions).toMatchObject([{ ticket, includePrimary: true }]);
    service.dispose();
  });
  it("blocks while waiting for user work without issuing a session-wide interrupt", async () => {
    const { service, interruptions } = setup();
    await service.createGoal("s", {
      actor: "user",
      objective: "work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "blocked",
      turnsUsed: 0,
      wallClockMs: 1000,
    });
    expect(interruptions).toEqual([]);
    service.dispose();
  });
  it("retains the deadline and cancellation scope after an objective edit invalidates mutation eligibility", async () => {
    const { service, interruptions } = setup();
    const goal = await service.createGoal("s", {
      actor: "user",
      objective: "work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    if (!ticket) throw new Error("missing ticket");
    service.bindTicketRun(ticket, "old-goal-root");
    await vi.advanceTimersByTimeAsync(400);
    await service.replaceGoal("s", "edited");
    await vi.advanceTimersByTimeAsync(600);
    expect(service.peekSnapshot("s")).toMatchObject({
      status: "blocked",
      wallClockMs: 1000,
    });
    expect(interruptions).toMatchObject([
      { expectedRunId: "old-goal-root", ticket },
    ]);
    service.dispose();
  });
  it("reschedules budgets and cancels stale timers on pause and dispose", async () => {
    const { service, interruptions } = setup();
    await service.createGoal("s", {
      actor: "user",
      objective: "work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(400);
    await service.setBudget("s", { wallClockBudgetMs: 2000 });
    await vi.advanceTimersByTimeAsync(600);
    expect(service.peekSnapshot("s")?.status).toBe("active");
    await service.pauseGoal("s");
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.peekSnapshot("s")?.wallClockMs).toBe(1000);
    await service.resumeGoal("s");
    service.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.peekSnapshot("s")?.status).toBe("active");
    expect(interruptions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not give back active time while a budget-only resume append is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistence = new InMemoryGoalPersistence();
    const service = new GoalService({
      persistence,
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    await service.createGoal("s", { actor: "user", objective: "work" });
    await vi.advanceTimersByTimeAsync(400);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append = persistence.append.bind(persistence);
    persistence.append = async (session, record) => {
      entered();
      await gate;
      await append(session, record);
    };
    const resume = service.resumeGoal("s", { wallClockBudgetMs: 2000 });
    await started;
    await vi.advanceTimersByTimeAsync(200);
    release();
    await resume;
    expect(service.peekSnapshot("s")?.wallClockMs).toBe(600);
    service.dispose();
  });

  it("rearms an early callback from current active usage", async () => {
    vi.useFakeTimers();
    let now = 0;
    const service = new GoalService({
      now: () => now,
      persistence: new InMemoryGoalPersistence(),
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    await service.createGoal("s", {
      actor: "user",
      objective: "work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.peekSnapshot("s")?.status).toBe("active");
    expect(vi.getTimerCount()).toBe(1);
    now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.peekSnapshot("s")?.status).toBe("blocked");
    expect(vi.getTimerCount()).toBe(0);
    service.dispose();
  });

  it.each(["cancel", "complete", "replace"])(
    "invalidates the old timer after %s",
    async (transition) => {
      const { service, interruptions } = setup();
      await service.createGoal("s", {
        actor: "user",
        objective: "old",
        budgetLimits: { wallClockBudgetMs: 1000 },
      });
      await vi.advanceTimersByTimeAsync(500);
      if (transition === "cancel") await service.cancelGoal("s");
      if (transition === "complete")
        await service.updateGoalFromModel("s", "complete");
      if (transition === "replace")
        await service.createGoal("s", {
          actor: "user",
          objective: "new",
          replace: true,
          budgetLimits: { wallClockBudgetMs: 2000 },
        });
      const calls = interruptions.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(interruptions).toHaveLength(calls);
      expect(service.peekSnapshot("s")?.status ?? null).toBe(
        transition === "replace" ? "active" : null,
      );
      expect(vi.getTimerCount()).toBe(transition === "replace" ? 1 : 0);
      service.dispose();
    },
  );
});

it("revalidates a queued old deadline against the latest committed budget without clearing the new timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const persistence = new InMemoryGoalPersistence();
  let tail = Promise.resolve();
  const service = new GoalService({
    persistence,
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
    withSessionMutation: (_session, op) => {
      const result = tail.then(op);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  await service.createGoal("s", {
    actor: "user",
    objective: "work",
    budgetLimits: { wallClockBudgetMs: 1000 },
  });
  await vi.advanceTimersByTimeAsync(500);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const append = persistence.append.bind(persistence);
  persistence.append = async (session, record) => {
    if (record.budgetLimits !== undefined) {
      entered();
      await gate;
    }
    await append(session, record);
  };
  const update = service.setBudget("s", { wallClockBudgetMs: 2000 });
  await started;
  await vi.advanceTimersByTimeAsync(500);
  release();
  await update;
  await vi.advanceTimersByTimeAsync(0);
  expect(service.peekSnapshot("s")?.status).toBe("active");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.peekSnapshot("s")).toMatchObject({
    status: "blocked",
    wallClockMs: 2000,
  });
  expect(vi.getTimerCount()).toBe(0);
  service.dispose();
});

it("starts a deadline when the first budget is set and blocks immediately when lowered below active usage", async () => {
  const { service } = setup();
  await service.createGoal("s", { actor: "user", objective: "work" });
  await vi.advanceTimersByTimeAsync(1500);
  await service.setBudget("s", { wallClockBudgetMs: 2000 });
  expect(vi.getTimerCount()).toBe(1);
  await service.setBudget("s", { wallClockBudgetMs: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(service.peekSnapshot("s")).toMatchObject({
    status: "blocked",
    wallClockMs: 1500,
  });
  expect(vi.getTimerCount()).toBe(0);
  service.dispose();
});

it.each(["preparation", "running"])(
  "stops the captured %s after deadline persistence fails, without committing blocked or retrying the driver",
  async (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistence = new InMemoryGoalPersistence();
    const failure = new Error("deadline disk unavailable");
    const errors: unknown[] = [];
    const interruptions: GoalExecutionInterruptInput[] = [];
    const service = new GoalService({
      persistence,
      executionControl: {
        interruptGoalExecution(input): Promise<void> {
          interruptions.push(input);
          return Promise.resolve();
        },
      },
      onError: ({ error }): void => {
        errors.push(error);
      },
    });
    let release!: () => void;
    let entered!: () => void;
    let calls = 0;
    let ticket: import("./types.js").GoalTurnTicket | undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.attachTurnRunner({
      async runTurn(sessionId, goalId, epoch) {
        calls += 1;
        const admitted = await service.admitTurnInBoundary(
          sessionId,
          goalId,
          epoch,
        );
        if (admitted === null) return { status: "not_admitted" as const };
        ticket = admitted;
        if (phase === "running") service.bindTicketRun(ticket, "goal-root");
        entered();
        await gate;
        return { status: "cancelled" as const, ticket };
      },
      finishTurn: (sessionId, admitted, outcome) =>
        service.settleTurn(sessionId, admitted, outcome),
    });
    await service.createGoal("s", {
      actor: "user",
      objective: "work",
      budgetLimits: { wallClockBudgetMs: 1000 },
    });
    await running;
    const epoch = service.currentExecutionEpoch("s");
    const records = await persistence.list("s");
    const append = persistence.append.bind(persistence);
    persistence.append = async (session, record): Promise<void> => {
      if (record.status === "blocked") throw failure;
      await append(session, record);
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticket?.controller.signal.aborted).toBe(true);
    expect(ticket?.stopIntent).toEqual({
      reason: "Active time budget reached",
      includePrimary: true,
    });
    expect(interruptions).toMatchObject([{ ticket, includePrimary: true }]);
    expect(interruptions[0]?.expectedRunId).toBe(
      phase === "running" ? "goal-root" : undefined,
    );
    expect(errors).toEqual([failure]);
    expect(service.peekSnapshot("s")?.status).toBe("active");
    expect(service.currentExecutionEpoch("s")).toBe(epoch);
    expect(await persistence.list("s")).toEqual(records);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await service.whenIdle();
    expect(service.peekSnapshot("s")?.status).toBe("paused");
    expect(service.peekSnapshot("s")?.pauseReason).toBe(
      "Active time budget reached",
    );
    expect((await persistence.list("s")).at(-1)?.actor).toBe("runtime");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    expect(errors).toEqual([failure]);
    service.dispose();
  },
);

it("reports a failed waiting-goal deadline without interrupting a user root", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const persistence = new InMemoryGoalPersistence();
  const errors: unknown[] = [];
  const interruptions: GoalExecutionInterruptInput[] = [];
  const service = new GoalService({
    persistence,
    executionControl: {
      interruptGoalExecution(input): Promise<void> {
        interruptions.push(input);
        return Promise.resolve();
      },
    },
    onError: ({ error }): void => {
      errors.push(error);
    },
  });
  await service.createGoal("s", {
    actor: "user",
    objective: "waiting",
    budgetLimits: { wallClockBudgetMs: 1000 },
  });
  const failure = new Error("disk");
  persistence.append = (): Promise<void> => Promise.reject(failure);
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.peekSnapshot("s")?.status).toBe("active");
  expect(interruptions).toEqual([]);
  expect(errors).toEqual([failure]);
  service.dispose();
});

it("preserves the deadline persistence error when captured-root interruption also fails", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const persistence = new InMemoryGoalPersistence();
  const original = new Error("disk");
  const cleanup = new Error("interrupt");
  const errors: unknown[] = [];
  const service = new GoalService({
    persistence,
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.reject(cleanup),
    },
    onError: ({ error }): void => {
      errors.push(error);
    },
  });
  const goal = await service.createGoal("s", {
    actor: "user",
    objective: "work",
    budgetLimits: { wallClockBudgetMs: 1000 },
  });
  const ticket = await service.admitTurnInBoundary(
    "s",
    goal.goalId,
    service.currentExecutionEpoch("s"),
  );
  persistence.append = (): Promise<void> => Promise.reject(original);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ticket?.controller.signal.aborted).toBe(true);
  expect(errors).toEqual([cleanup, original]);
  expect(service.peekSnapshot("s")?.status).toBe("active");
  service.dispose();
});
