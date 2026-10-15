import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import {
  createSqliteGoalPersistence,
  InMemoryGoalPersistence,
} from "./persistence.js";
import { GoalStore } from "./store.js";
import type { GoalPersistencePort } from "./types.js";

describe("goal persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goals-db-"));
    initDatabase({ dbPath: join(dir, "test.db") });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { force: true, recursive: true });
  });

  const suite = (name: string, make: () => GoalPersistencePort): void => {
    describe(name, () => {
      it.each([false, true])(
        "U11 validates criterion before replacing or rejecting an existing goal (replace=%s)",
        async (replace) => {
          const persistence = make();
          const store = await GoalStore.rebuild({
            persistence,
            sessionId: "s1",
            now: () => 1000,
          });
          const original = await store.create({
            actor: "user",
            objective: "original",
            completionCriterion: "keep this",
          });
          await store.incrementTurn();
          await store.recordUsage(original.goalId, {
            totalTokens: 42,
            cachedInputTokens: 12,
            usageComplete: true,
          });
          await store.pause("waiting", "user");
          const before = store.getSnapshot();
          const records = await persistence.list("s1");
          await expect(
            store.create({
              actor: "user",
              objective: "replacement",
              completionCriterion: "x".repeat(6001),
              replace,
            }),
          ).rejects.toMatchObject({ code: "invalid_criterion" });
          expect(store.getSnapshot()).toEqual(before);
          expect(await persistence.list("s1")).toEqual(records);
          const rebuilt = await GoalStore.rebuild({
            persistence,
            sessionId: "s1",
            now: () => 1000,
          });
          expect(rebuilt.getSnapshot()).toEqual(before);
        },
      );

      it("U10 reads legacy criterion verbatim without applying new-write limits", async () => {
        const persistence = make();
        const completionCriterion = ` ${"x".repeat(6001)} `;
        await persistence.append("s1", {
          type: "create",
          goalId: "legacy",
          objective: "legacy",
          completionCriterion,
        });
        await persistence.append("s1", {
          type: "update",
          goalId: "legacy",
          status: "paused",
        });
        const records = await persistence.list("s1");
        const store = await GoalStore.rebuild({ persistence, sessionId: "s1" });
        expect(store.getSnapshot()?.completionCriterion).toBe(
          completionCriterion,
        );
        expect(await persistence.list("s1")).toEqual(records);
      });

      it("appends records with increasing seq and lists them in order", async () => {
        const persistence = make();
        await persistence.append("s1", {
          goalId: "g1",
          objective: "fix tests",
          type: "create",
        });
        await persistence.append("s1", {
          goalId: "g1",
          reason: "interrupted",
          status: "paused",
          type: "update",
        });
        const records = await persistence.list("s1");
        expect(records.map((record) => record.seq)).toEqual([1, 2]);
        expect(records[0]).toMatchObject({
          goalId: "g1",
          sessionId: "s1",
          type: "create",
        });
        expect(records[1]).toMatchObject({ status: "paused", type: "update" });
      });

      it("G12/G19 replays admitted counts, ignores stale goal records and legacy token limits", async () => {
        const persistence = make();
        await persistence.append("s1", {
          type: "create",
          goalId: "current",
          objective: "current",
          budgetLimits: { tokenBudget: 1 } as never,
        });
        await persistence.append("s1", {
          type: "update",
          goalId: "current",
          turnsUsed: 1,
          tokensUsed: 500,
        });
        await persistence.append("s1", {
          type: "update",
          goalId: "old",
          turnsUsed: 99,
          status: "complete",
        });
        await persistence.append("s1", { type: "clear", goalId: "old" });
        const store = await GoalStore.rebuild({ persistence, sessionId: "s1" });
        expect(store.getSnapshot()).toMatchObject({
          goalId: "current",
          status: "paused",
          turnsUsed: 1,
          tokensUsed: 500,
          budgetLimits: {},
          budget: { overBudget: false, converging: false },
        });
        expect((await persistence.list("s1")).at(-1)?.status).toBe("paused");
      });

      it("G15 clears a persisted complete residual without demoting or replaying a turn", async () => {
        const persistence = make();
        await persistence.append("s1", {
          type: "create",
          goalId: "done",
          objective: "done",
        });
        await persistence.append("s1", {
          type: "update",
          goalId: "done",
          status: "complete",
          turnsUsed: 1,
          tokensUsed: 20,
        });
        const store = await GoalStore.rebuild({ persistence, sessionId: "s1" });
        expect(store.getSnapshot()).toBeNull();
        expect(
          (await persistence.list("s1")).map((r) => r.status ?? r.type),
        ).toEqual(["create", "complete", "clear"]);
      });

      it.each([false, true])(
        "G16 rejects completed edits but allows create (replace=%s)",
        async (replace) => {
          const persistence = make();
          const store = await GoalStore.rebuild({
            persistence,
            sessionId: "s1",
          });
          const old = await store.create({ actor: "user", objective: "done" });
          await store.markComplete("model");
          const before = await persistence.list("s1");
          await expect(store.resume("user")).rejects.toThrow();
          await expect(
            store.replaceObjective("edit", "user"),
          ).rejects.toThrow();
          await expect(
            store.setBudgetLimits({ turnBudget: 4 }, "model"),
          ).rejects.toThrow();
          expect(await persistence.list("s1")).toEqual(before);
          const current = await store.create({
            actor: "model",
            objective: "next",
            replace,
          });
          expect(current.goalId).not.toBe(old.goalId);
          await store.recordUsage(old.goalId, {
            totalTokens: 99,
            cachedInputTokens: 88,
            usageComplete: true,
          });
          await store.clearCompleted(old.goalId);
          expect(store.getSnapshot()).toMatchObject({
            goalId: current.goalId,
            status: "active",
            tokensUsed: 0,
          });
        },
      );

      it.each([
        { totalTokens: 12, usageComplete: false },
        { cachedInputTokens: 7, usageComplete: false },
        { usageComplete: false },
      ])("G17 persists only known usage fields %#", async (usage) => {
        const persistence = make();
        const store = await GoalStore.rebuild({ persistence, sessionId: "s1" });
        const goal = await store.create({
          actor: "user",
          objective: "partial statistics",
        });
        await store.recordUsage(goal.goalId, usage);
        const record = (await persistence.list("s1")).at(-1);
        expect(record?.usageIncomplete).toBe(true);
        if ("totalTokens" in usage) expect(record?.tokensUsed).toBe(12);
        else expect(record).not.toHaveProperty("tokensUsed");
        if ("cachedInputTokens" in usage)
          expect(record?.cachedTokensUsed).toBe(7);
        else expect(record).not.toHaveProperty("cachedTokensUsed");
      });

      it("isolates sessions", async () => {
        const persistence = make();
        await persistence.append("s1", {
          goalId: "g1",
          objective: "a",
          type: "create",
        });
        await persistence.append("s2", {
          goalId: "g2",
          objective: "b",
          type: "create",
        });
        expect(await persistence.list("s1")).toHaveLength(1);
        expect(await persistence.list("s2")).toHaveLength(1);
      });

      it("returns empty list for unknown session", async () => {
        expect(await make().list("nope")).toEqual([]);
      });
    });
  };

  suite("sqlite", () => createSqliteGoalPersistence(getDatabase()));
  suite("in-memory", () => new InMemoryGoalPersistence());
});
