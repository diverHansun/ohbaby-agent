import { describe, expect, it } from "vitest";
import { GoalError } from "./errors.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalStore } from "./store.js";
import type { GoalPersistencePort } from "./types.js";

const ACTOR = "user" as const;

async function makeStore(now: () => number = () => 1000): Promise<{
  persistence: InMemoryGoalPersistence;
  store: GoalStore;
}> {
  const persistence = new InMemoryGoalPersistence(now);
  const store = await GoalStore.rebuild({
    createGoalId: () => "g1",
    now,
    persistence,
    sessionId: "s1",
  });
  return { persistence, store };
}

describe("GoalStore state machine", () => {
  it("create sets active and returns snapshot", async () => {
    const { store } = await makeStore();
    const snapshot = await store.create({
      actor: ACTOR,
      objective: "fix tests",
    });
    expect(snapshot.status).toBe("active");
    expect(snapshot.objective).toBe("fix tests");
    expect(store.getSnapshot()?.goalId).toBe("g1");
  });

  it("create rejects empty and oversized objectives", async () => {
    const { store } = await makeStore();
    await expect(
      store.create({ actor: ACTOR, objective: "  " }),
    ).rejects.toThrow(GoalError);
    await expect(
      store.create({ actor: ACTOR, objective: "x".repeat(4001) }),
    ).rejects.toThrow(GoalError);
  });

  it("create over existing goal requires replace", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await expect(
      store.create({ actor: ACTOR, objective: "b" }),
    ).rejects.toThrow(GoalError);
    const replaced = await store.create({
      actor: ACTOR,
      objective: "b",
      replace: true,
    });
    expect(replaced.objective).toBe("b");
  });

  it("pause/resume round-trip clears pause reason", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    const paused = await store.pause("interrupted", "user");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("interrupted");
    const resumed = await store.resume("user");
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeUndefined();
  });

  it("resume without goal throws no_goal", async () => {
    const { store } = await makeStore();
    await expect(store.resume("user")).rejects.toMatchObject({
      code: "no_goal",
    });
  });

  it("markComplete announces then clears; complete never rests on disk", async () => {
    const { persistence, store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    const changes: string[] = [];
    store.onChange = (_snapshot, change): void => {
      changes.push(change.kind);
    };
    const final = await store.markComplete("model");
    expect(final.status).toBe("complete");
    expect(store.getSnapshot()).toBeNull();
    expect(changes).toContain("completion");
    const rebuilt = await GoalStore.rebuild({ persistence, sessionId: "s1" });
    expect(rebuilt.getSnapshot()).toBeNull();
  });

  it("cancel discards; second cancel is a no-op", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.cancel("user");
    expect(store.getSnapshot()).toBeNull();
    await expect(store.cancel("user")).resolves.toBeUndefined();
  });

  it("terminal runtime/model transitions do not overwrite paused goals", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.pause("user stop", "user");

    await store.markComplete("model");
    expect(store.getSnapshot()).toMatchObject({
      status: "paused",
      pauseReason: "user stop",
    });

    await store.resume("user");
    await store.pause("needs input", "model");
    await store.pause("late pause", "runtime");
    await store.markComplete("model");
    expect(store.getSnapshot()).toMatchObject({
      status: "paused",
      pauseReason: "needs input",
    });
  });

  it("incrementTurn and recordTokenUsage only advance while active", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.incrementTurn();
    await store.recordTokenUsage(500);
    await store.pause("stop", "user");
    await store.incrementTurn();
    await store.recordTokenUsage(500);
    const snapshot = store.getSnapshot();
    expect(snapshot?.turnsUsed).toBe(1);
    expect(snapshot?.tokensUsed).toBe(500);
  });

  it("setBudgetLimits reflects in snapshot budget report", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.setBudgetLimits({ turnBudget: 10 }, "user");
    expect(store.getSnapshot()?.budget.turnBudget).toBe(10);
    expect(store.getSnapshot()?.budgetLimits.turnBudget).toBe(10);
  });

  it("setBudgetLimits merges partial updates", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.setBudgetLimits({ tokenBudget: 1000 }, "user");
    await store.setBudgetLimits({ turnBudget: 10 }, "user");

    expect(store.getSnapshot()?.budgetLimits).toEqual({
      tokenBudget: 1000,
      turnBudget: 10,
    });
  });

  it("replaceObjective swaps the objective in place", async () => {
    const { store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.pause("edit", "user");
    const replaced = await store.replaceObjective("b", "user");
    expect(replaced.objective).toBe("b");
    expect(replaced.status).toBe("paused");
  });

  it("wall-clock accumulates only across active intervals", async () => {
    let time = 1000;
    const { store } = await makeStore(() => time);
    await store.create({ actor: ACTOR, objective: "a" });
    time = 3000;
    const paused = await store.pause("stop", "user");
    expect(paused.wallClockMs).toBe(2000);
    time = 10000;
    expect(store.getSnapshot()?.wallClockMs).toBe(2000);
    await store.resume("user");
    time = 11000;
    expect(store.getSnapshot()?.wallClockMs).toBe(3000);
  });
});

describe("GoalStore rebuild + normalizeAfterReplay", () => {
  it("replays records to consistent state including usage and budget", async () => {
    const { persistence, store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    await store.setBudgetLimits({ turnBudget: 10 }, "user");
    await store.incrementTurn();
    await store.pause("interrupted", "user");
    const rebuilt = await GoalStore.rebuild({ persistence, sessionId: "s1" });
    const snapshot = rebuilt.getSnapshot();
    expect(snapshot?.status).toBe("paused");
    expect(snapshot?.turnsUsed).toBe(1);
    expect(snapshot?.budget.turnBudget).toBe(10);
  });

  it("demotes replayed active to paused (never auto-runs)", async () => {
    const { persistence, store } = await makeStore();
    await store.create({ actor: ACTOR, objective: "a" });
    expect(store.getSnapshot()?.status).toBe("active");
    const rebuilt = await GoalStore.rebuild({ persistence, sessionId: "s1" });
    const snapshot = rebuilt.getSnapshot();
    expect(snapshot?.status).toBe("paused");
    expect(snapshot?.pauseReason).toBe("Paused after agent resume");
  });

  it("normalizes legacy blocked records to paused with pauseReason", async () => {
    const persistence = new InMemoryGoalPersistence();
    await persistence.append("s1", {
      goalId: "g1",
      objective: "legacy",
      type: "create",
    });
    await persistence.append("s1", {
      goalId: "g1",
      reason: "legacy block",
      status: "blocked",
      type: "update",
    });

    const rebuilt = await GoalStore.rebuild({ persistence, sessionId: "s1" });

    expect(rebuilt.getSnapshot()).toMatchObject({
      pauseReason: "legacy block",
      status: "paused",
    });
  });

  it("persistence append failure is surfaced and memory unchanged", async () => {
    const failing: GoalPersistencePort = {
      append: () => Promise.reject(new Error("disk full")),
      list: () => Promise.resolve([]),
    };
    const broken = await GoalStore.rebuild({
      persistence: failing,
      sessionId: "s2",
    });
    await expect(
      broken.create({ actor: ACTOR, objective: "a" }),
    ).rejects.toThrow("disk full");
    expect(broken.getSnapshot()).toBeNull();
  });
});
