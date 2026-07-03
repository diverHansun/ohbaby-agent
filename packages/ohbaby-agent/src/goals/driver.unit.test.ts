import { describe, expect, it } from "vitest";
import { driveGoal } from "./driver.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalStore } from "./store.js";
import type { GoalTurnOutcome, GoalTurnRunner } from "./types.js";

async function makeActiveStore(): Promise<GoalStore> {
  const store = await GoalStore.rebuild({
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
): { runner: GoalTurnRunner; prompts: string[] } {
  const prompts: string[] = [];
  let turn = 0;
  return {
    prompts,
    runner: {
      async runTurn(_sessionId, promptText): Promise<GoalTurnOutcome> {
        prompts.push(promptText);
        turn += 1;
        return script(turn, store);
      },
    },
  };
}

describe("driveGoal", () => {
  it("runs turns until the model completes via store, counting the final turn", async () => {
    const store = await makeActiveStore();
    const { prompts, runner } = scriptedRunner(async (turn, s) => {
      if (turn === 3) await s.markComplete("model");
      return { status: "succeeded" };
    }, store);
    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("You are starting work under a goal");
    expect(prompts[1]).toContain("Continue working toward the active goal.");
    expect(store.getSnapshot()).toBeNull();
  });

  it("cancelled outcome pauses the goal with 'interrupted'", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(() => ({ status: "cancelled" }), store);
    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.terminalReason).toBe("interrupted");
  });

  it("failed outcome pauses with runtime error reason", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(
      () => ({ error: "provider retry exhausted", status: "failed" }),
      store,
    );
    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });
    expect(store.getSnapshot()?.status).toBe("paused");
    expect(store.getSnapshot()?.terminalReason).toContain(
      "provider retry exhausted",
    );
  });

  it("failed outcome does not demote an already-blocked goal", async () => {
    const store = await makeActiveStore();
    const { runner } = scriptedRunner(async (_turn, s) => {
      await s.markBlocked("needs review", "model");
      return { error: "late transport error", status: "failed" };
    }, store);

    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });

    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.terminalReason).toBe("needs review");
  });

  it("blocks when a set turn budget is exhausted", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ turnBudget: 2 }, "user");
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });
    expect(prompts).toHaveLength(2);
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.terminalReason).toContain("budget");
  });

  it("blocks at safety cap when no turn budget set", async () => {
    const store = await makeActiveStore();
    const { prompts, runner } = scriptedRunner(
      () => ({ status: "succeeded" }),
      store,
    );
    await driveGoal({ runner, safetyCapTurns: 3, sessionId: "s1", store });
    expect(prompts).toHaveLength(3);
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.terminalReason).toContain("Safety cap");
  });

  it("records token usage from outcome toward token budget", async () => {
    const store = await makeActiveStore();
    await store.setBudgetLimits({ tokenBudget: 1000 }, "user");
    const { runner } = scriptedRunner(
      () => ({ status: "succeeded", tokensUsed: 600 }),
      store,
    );
    await driveGoal({ runner, safetyCapTurns: 200, sessionId: "s1", store });
    expect(store.getSnapshot()?.status).toBe("blocked");
    expect(store.getSnapshot()?.tokensUsed).toBeGreaterThanOrEqual(1000);
  });
});
