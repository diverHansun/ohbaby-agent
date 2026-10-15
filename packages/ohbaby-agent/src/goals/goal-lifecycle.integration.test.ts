import { describe, expect, it } from "vitest";
import { GoalService } from "./service.js";
import { GoalStore } from "./store.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import type { GoalMutationContext, GoalTurnTicket } from "./types.js";

function setup(now?: () => number) {
  const persistence = new InMemoryGoalPersistence();
  let tail = Promise.resolve();
  const service: GoalService = new GoalService({
    persistence,
    ...(now === undefined ? {} : { now }),
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
    resolveMutationContext: (session, run): GoalMutationContext => {
      const ticket = service.getTicketForRun(session, run);
      return ticket
        ? { kind: "goal", ticket }
        : run === "user"
          ? { kind: "user" }
          : { kind: "invalid" };
    },
  });
  async function admit(): Promise<GoalTurnTicket> {
    const goal = service.peekSnapshot("s");
    if (!goal) throw new Error("missing goal");
    const ticket = await service.admitTurnInBoundary(
      "s",
      goal.goalId,
      service.currentExecutionEpoch("s"),
    );
    if (!ticket) throw new Error("not admitted");
    service.bindTicketRun(ticket, `run-${String(ticket.turnNumber)}`);
    return ticket;
  }
  const report = (ticket: GoalTurnTicket, reason = " Waiting for access ") =>
    service.updateGoalFromModel("s", "blocked", reason, ticket.runId);
  const finish = (ticket: GoalTurnTicket) =>
    service.settleTurn("s", ticket, {
      status: "succeeded",
      usage: { usageComplete: true },
    });
  return { service, persistence, admit, report, finish };
}

describe("goal lifecycle persistence", () => {
  it("requires three adjacent admitted runs, deduplicates the same run and preserves blocked on replay", async () => {
    const { service, persistence, admit, report, finish } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    for (let turn = 1; turn <= 3; turn++) {
      const ticket = await admit();
      const result = await report(ticket);
      expect(result.snapshot?.status).toBe(turn === 3 ? "blocked" : "active");
      if (turn < 3) {
        expect(result.note).toContain(`${String(turn)}/3`);
        await report(ticket, "different reason must not replace this turn");
      }
      await finish(ticket);
    }
    const rebuilt = await GoalStore.rebuild({ persistence, sessionId: "s" });
    expect(rebuilt.getSnapshot()).toMatchObject({
      status: "blocked",
      pauseReason: "Waiting for access",
      turnsUsed: 3,
    });
  });

  it("keeps a failed third append retryable in the same run", async () => {
    const { service, persistence, admit, report, finish } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    for (let i = 0; i < 2; i++) {
      const t = await admit();
      await report(t);
      await finish(t);
    }
    const third = await admit();
    const append = persistence.append.bind(persistence);
    persistence.append = async (session, record) => {
      if (record.status === "blocked") throw new Error("disk");
      await append(session, record);
    };
    await expect(report(third)).rejects.toThrow("disk");
    expect(service.peekSnapshot("s")?.status).toBe("active");
    persistence.append = append;
    expect((await report(third)).snapshot?.status).toBe("blocked");
  });

  it("atomically rejects partial replenishment and restores both dimensions in one record", async () => {
    let time = 0;
    const { service, persistence, admit, finish } = setup(() => time);
    await service.createGoal("s", {
      objective: "work",
      actor: "user",
      budgetLimits: { turnBudget: 1, wallClockBudgetMs: 1000 },
    });
    await finish(await admit());
    time = 1000;
    await service.pauseGoal("s");
    const before = await persistence.list("s");
    const snapshot = service.peekSnapshot("s");
    expect(snapshot).toMatchObject({ turnsUsed: 1, wallClockMs: 1000 });
    for (const limits of [
      {},
      { turnBudget: 3 },
      { wallClockBudgetMs: 10000 },
    ]) {
      await expect(service.resumeGoal("s", limits)).rejects.toThrow();
      expect(await persistence.list("s")).toEqual(before);
      expect(service.peekSnapshot("s")).toEqual(snapshot);
    }
    const resumed = await service.resumeGoal("s", {
      turnBudget: 3,
      wallClockBudgetMs: 10_000,
    });
    expect(resumed).toMatchObject({
      status: "active",
      turnsUsed: 1,
      budgetLimits: { turnBudget: 3, wallClockBudgetMs: 10_000 },
    });
    expect(resumed.pauseReason).toBeUndefined();
    expect((await persistence.list("s")).slice(before.length)).toMatchObject([
      { status: "active", budgetLimits: resumed.budgetLimits },
    ]);
    service.dispose();
  });

  it("serializes resume and budget updates without losing either dimension", async () => {
    const { service } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    await service.pauseGoal("s");
    await service.setBudget("s", { turnBudget: 4 }, "user");
    expect(service.peekSnapshot("s")?.status).toBe("paused");
    await Promise.all([
      service.resumeGoal("s", { wallClockBudgetMs: 10_000 }),
      service.setBudget("s", { turnBudget: 8 }, "user"),
    ]);
    expect(service.peekSnapshot("s")?.budgetLimits).toEqual({
      turnBudget: 8,
      wallClockBudgetMs: 10_000,
    });
    service.dispose();
  });

  it("rejects model lifecycle statuses other than complete or blocked", async () => {
    const { service } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    await expect(
      service.updateGoalFromModel("s", "active", undefined, "user"),
    ).rejects.toThrow();
    await expect(
      service.updateGoalFromModel("s", "paused", undefined, "user"),
    ).rejects.toThrow();
    await expect(
      service.updateGoalFromModel("s", "blocked", "  ", "user"),
    ).rejects.toThrow();
    expect(
      (await service.updateGoalFromModel("s", "blocked", "waiting", "user"))
        .snapshot?.status,
    ).toBe("active");
  });
  it("preserves the audit across no-op edits, active resume and budget changes", async () => {
    const { service, admit, report, finish } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    const first = await admit();
    await report(first);
    await finish(first);
    const epoch = service.currentExecutionEpoch("s");
    await service.replaceGoal("s", " work ");
    await service.resumeGoal("s");
    await service.resumeGoal("s", { turnBudget: 10 });
    await service.setBudget("s", { turnBudget: 20 }, "user");
    expect(service.currentExecutionEpoch("s")).toBe(epoch);
    const second = await admit();
    expect((await report(second)).note).toContain("2/3");
    await finish(second);
    expect((await report(await admit())).snapshot?.status).toBe("blocked");
  });

  it.each(["resume", "objective", "new goal"])(
    "resets the audit after %s",
    async (transition) => {
      const { service, admit, report, finish } = setup();
      await service.createGoal("s", { objective: "work", actor: "user" });
      for (let i = 0; i < 2; i++) {
        const ticket = await admit();
        await report(ticket);
        await finish(ticket);
      }
      if (transition === "resume") {
        await service.pauseGoal("s");
        await service.resumeGoal("s");
      }
      if (transition === "objective") await service.replaceGoal("s", "changed");
      if (transition === "new goal")
        await service.createGoal("s", {
          objective: "new",
          actor: "user",
          replace: true,
        });
      expect((await report(await admit())).note).toContain("1/3");
    },
  );

  it("breaks the audit across a silent admitted run and rejects stale goal mutations", async () => {
    const { service, admit, report, finish } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    const first = await admit();
    await report(first);
    await finish(first);
    await finish(await admit());
    const third = await admit();
    expect((await report(third)).note).toContain("1/3");
    await service.replaceGoal("s", "changed");
    await expect(report(third)).rejects.toThrow("permission");
    expect(service.peekSnapshot("s")?.status).toBe("active");
  });

  it("keeps state, budget and records intact when atomic resume append fails", async () => {
    const { service, persistence } = setup();
    await service.createGoal("s", {
      objective: "work",
      actor: "user",
      budgetLimits: { turnBudget: 5 },
    });
    await service.pauseGoal("s", "review");
    const snapshot = service.peekSnapshot("s");
    const records = await persistence.list("s");
    persistence.append = (): Promise<void> => Promise.reject(new Error("disk"));
    await expect(service.resumeGoal("s", { turnBudget: 10 })).rejects.toThrow(
      "disk",
    );
    expect(service.peekSnapshot("s")).toEqual(snapshot);
    expect(await persistence.list("s")).toEqual(records);
  });

  it("merges a queued budget mutation after a deferred resume append", async () => {
    const { service, persistence } = setup();
    await service.createGoal("s", { objective: "work", actor: "user" });
    await service.pauseGoal("s");
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
      if (record.status === "active") {
        entered();
        await gate;
      }
      await append(session, record);
    };
    const resume = service.resumeGoal("s", { turnBudget: 10 });
    await started;
    const update = service.setBudget(
      "s",
      { wallClockBudgetMs: 10_000 },
      "user",
    );
    release();
    await Promise.all([resume, update]);
    expect(service.peekSnapshot("s")?.budgetLimits).toEqual({
      turnBudget: 10,
      wallClockBudgetMs: 10_000,
    });
    service.dispose();
  });
});

it("isolates audit chains for sessions even when their run identifiers coincide", async () => {
  const { service, admit, report, finish } = setup();
  await service.createGoal("s", { actor: "user", objective: "first" });
  const other = await service.createGoal("other", {
    actor: "user",
    objective: "second",
  });
  const first = await admit();
  await report(first);
  await finish(first);
  const otherTicket = await service.admitTurnInBoundary(
    "other",
    other.goalId,
    service.currentExecutionEpoch("other"),
  );
  if (otherTicket === null) throw new Error("not admitted");
  service.bindTicketRun(otherTicket, "run-1");
  expect(
    (
      await service.updateGoalFromModel(
        "other",
        "blocked",
        "other reason",
        "run-1",
      )
    ).note,
  ).toContain("1/3");
  expect((await report(await admit())).note).toContain("2/3");
  expect(service.peekSnapshot("other")?.status).toBe("active");
});

it("keeps a budget-adjusted blocked goal stopped until explicit resume starts the attached driver", async () => {
  const { service, admit, report, finish } = setup();
  await service.createGoal("s", { actor: "user", objective: "work" });
  for (let i = 0; i < 3; i++) {
    const ticket = await admit();
    await report(ticket);
    await finish(ticket);
  }
  let calls = 0;
  service.attachTurnRunner({
    async runTurn(sessionId, goalId, epoch) {
      calls += 1;
      const ticket = await service.admitTurnInBoundary(
        sessionId,
        goalId,
        epoch,
      );
      return ticket === null
        ? { status: "not_admitted" as const }
        : { status: "cancelled" as const, ticket };
    },
    finishTurn: (sessionId, ticket, outcome) =>
      service.settleTurn(sessionId, ticket, outcome),
  });
  await service.setBudget("s", { turnBudget: 10 }, "user");
  await service.whenIdle();
  expect(service.peekSnapshot("s")).toMatchObject({
    status: "blocked",
    turnsUsed: 3,
    budgetLimits: { turnBudget: 10 },
  });
  expect(calls).toBe(0);
  expect((await service.resumeGoal("s")).status).toBe("active");
  await service.whenIdle();
  expect(calls).toBe(1);
  expect(service.peekSnapshot("s")).toMatchObject({
    status: "paused",
    turnsUsed: 4,
  });
  service.dispose();
});

it("rebuilds a new service after two reports with an empty audit but preserved usage", async () => {
  const { service, persistence, admit, report, finish } = setup();
  await service.createGoal("s", { actor: "user", objective: "work" });
  for (let i = 0; i < 2; i++) {
    const ticket = await admit();
    await report(ticket);
    await finish(ticket);
  }
  service.dispose();
  const restarted: GoalService = new GoalService({
    persistence,
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
    resolveMutationContext: (session, run): GoalMutationContext => {
      const ticket = restarted.getTicketForRun(session, run);
      return ticket === undefined
        ? { kind: "invalid" }
        : { kind: "goal", ticket };
    },
  });
  await restarted.initSession("s");
  expect(restarted.peekSnapshot("s")).toMatchObject({
    status: "paused",
    turnsUsed: 2,
  });
  const resumed = await restarted.resumeGoal("s");
  const ticket = await restarted.admitTurnInBoundary(
    "s",
    resumed.goalId,
    restarted.currentExecutionEpoch("s"),
  );
  if (ticket === null) throw new Error("not admitted");
  restarted.bindTicketRun(ticket, "restarted-run");
  const result = await restarted.updateGoalFromModel(
    "s",
    "blocked",
    "waiting for access",
    "restarted-run",
  );
  expect(result.note).toContain("1/3");
  expect(result.snapshot).toMatchObject({ status: "active", turnsUsed: 3 });
  restarted.dispose();
});
