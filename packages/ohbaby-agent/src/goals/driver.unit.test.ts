import { describe, expect, it } from "vitest";
import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";
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
      async runTurn(_sessionId, promptText, goalId): Promise<GoalTurnOutcome> {
        prompts.push(promptText);
        goalIds.push(goalId);
        turn += 1;
        return script(turn, store);
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
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });

    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toBe("needs review");
  });

  it("pauses when a set turn budget is exhausted", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 2 }, "user");
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(2);
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toContain("budget");
  });

  it("pauses at safety cap when no turn budget set", async () => {
    const store = await makeActiveStore();
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      runner,
      safetyCapTurns: 3,
      sessionId: "s1",
      store,
    });
    expect(prompts).toHaveLength(3);
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.pauseReason).toContain("Safety cap");
  });

  it("pauses at the system safety cap even when a larger turn budget is set", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 1000 }, "user");
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
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
      runner,
      safetyCapTurns: 1000,
      sessionId: "s1",
      store,
    });

    expect(prompts).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({
      pauseReason: "A configured budget was reached",
      status: "paused",
      wallClockMs: 1_000,
    });
  });

  it("records token usage from outcome toward token budget", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ tokenBudget: 1000 }, "user");
    const { runner } = scriptedRunner(
      () => ({ status: "succeeded", tokensUsed: 600 }),
      store,
    );
    await driveGoal({
      pause: (reason, actor) => store.pause(reason, actor),
      runner,
      safetyCapTurns: 200,
      sessionId: "s1",
      store,
    });
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.tokensUsed).toBeGreaterThanOrEqual(1000);
  });
});
