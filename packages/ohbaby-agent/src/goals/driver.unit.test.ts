import { describe, expect, it } from "vitest";
import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";
import { renderGoalTurnPrompt } from "./injection.js";
import { driveGoal } from "./driver.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalStore } from "./store.js";
import type { GoalTurnOutcome, GoalTurnRunner } from "./types.js";

async function makeActiveStore(now?: () => number): Promise<GoalStore> {
  const store = await GoalStore.rebuild({
    ...(now === undefined ? {} : { now }),
    persistence: new InMemoryGoalPersistence(),
    sessionId: "s1",
  });
  await store.create({ actor: "user", objective: "fix tests" });
  return store;
}

function scriptedRunner(
  script: (
    turn: number,
    store: GoalStore,
  ) => Promise<GoalTurnOutcome> | GoalTurnOutcome,
  store: GoalStore,
): { runner: GoalTurnRunner; prompts: string[]; goalIds: string[] } {
  const prompts: string[] = [];
  const goalIds: string[] = [];
  let turn = 0;
  return {
    prompts,
    goalIds,
    runner: {
      async runTurn(
        _sessionId,
        goalId,
        executionEpoch,
      ): Promise<GoalTurnOutcome> {
        await store.incrementTurn();
        const snapshot = store.getSnapshot();
        if (snapshot === null) throw new Error("missing goal");
        const modelText = renderGoalTurnPrompt(snapshot, {
          isFirstTurn: snapshot.turnsUsed === 1,
        });
        prompts.push(modelText);
        goalIds.push(goalId);
        turn += 1;
        return {
          ...(await script(turn, store)),
          ticket: {
            goalId,
            executionEpoch,
            turnNumber: snapshot.turnsUsed,
            modelText,
            displayText: "",
            token: Symbol(),
            controller: new AbortController(),
            settled: false,
          },
        };
      },
      async finishTurn(_sessionId, ticket, outcome): Promise<void> {
        await store.recordUsage(
          ticket.goalId,
          outcome.usage ?? { usageComplete: false },
        );
        if (store.getSnapshot()?.status === "complete")
          await store.cancel("runtime");
      },
    },
  };
}

describe("driveGoal", () => {
  it("uses a 1000-turn system safety cap", () => {
    expect(GOAL_SAFETY_CAP_TURNS).toBe(1000);
  });

  it("runs turns until the model completes via store, counting the final turn", async () => {
    const store = await makeActiveStore();
    const { goalIds, prompts, runner } = scriptedRunner(async (turn, s) => {
      if (turn === 3) await s.markComplete("model");
      return { status: "succeeded" };
    }, store);
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(3);
    expect(goalIds).toEqual(Array.from({ length: 3 }, () => goalIds[0]));
    expect(goalIds[0]).toBeTruthy();
    expect(prompts[0]).toContain("You are starting work under a goal");
    expect(prompts[1]).toContain("Continue working toward the active goal.");
    expect(store.getSnapshot()).toBeNull();
  });

  it("cancelled outcome pauses the goal with 'interrupted'", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(() => ({ status: "cancelled" }), store);
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toBe("interrupted");
  });

  it("failed outcome pauses with runtime error reason", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(
      () => ({ error: "provider retry exhausted", status: "failed" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toContain(
      "provider retry exhausted",
    );
  });

  it("failed outcome does not overwrite an already-paused goal", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(async (_turn, s) => {
      await s.pause("needs review", "model");
      return { error: "late transport error", status: "failed" };
    }, store);

    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });

    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toBe("needs review");
  });

  it("blocks when a set turn budget is exhausted", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 2 }, "user");
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(2);
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.pauseReason).toContain("budget");
  });

  it("blocks at safety cap when no turn budget set", async () => {
    const store = await makeActiveStore();
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 3,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(3);
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.pauseReason).toContain("Safety cap");
  });

  it("blocks at the system safety cap even when a larger turn budget is set", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 1000 }, "user");
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 3,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(3);
    expect(store.getSnapshot()?.pauseReason).toContain("Safety cap");
  });

  it("enforces active-time budgets at continuation boundaries", async () => {
    let time = 0;
    const store = await makeActiveStore(() => time);
    await store.setBudgetLimits({ wallClockBudgetMs: 1_000 }, "user");
    const { prompts, runner } = scriptedRunner(() => {
      time = 1_000;
      return { status: "succeeded" };
    }, store);

    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 1000,
      sessionId: "s1",
      store,
    });

    expect(prompts).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({
      pauseReason: "A configured budget was reached",
      status: "blocked",
      wallClockMs: 1_000,
    });
  });

  it("records token usage as statistics independently of budget", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 2 }, "user");
    const { runner } = scriptedRunner(
      () => ({
        status: "succeeded",
        usage: { totalTokens: 600, usageComplete: true },
      }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      block: (reason, actor) => store.block(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.tokensUsed).toBeGreaterThanOrEqual(1000);
  });
});

it("exits a still-current lifecycle when adapter admission closes", async () => {
  const store = await makeActiveStore();
  let calls = 0;
  await driveGoal({
    store,
    sessionId: "s1",
    safetyCapTurns: 1000,
    isCurrent: () => store.getSnapshot()?.status === "active",
    pause: (reason, actor) => store.pause(reason, actor),
    block: (reason, actor) => store.block(reason, actor),
    runner: {
      runTurn: () =>
        Promise.resolve({
          status: ++calls === 1 ? "not_admitted" : "cancelled",
        }),
    },
  });
  expect(calls).toBe(1);
  expect(store.getSnapshot()?.status).toBe("active");
});
