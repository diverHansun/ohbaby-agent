import { describe, expect, it } from "vitest";
import {
  computeBudgetReport,
  isSafetyCapReached,
  planResume,
} from "./budget.js";

import type { GoalSnapshot, GoalUsage } from "./types.js";

const usage = (turns: number, tokens = 0, ms = 0): GoalUsage => ({
  tokensUsed: tokens,
  turnsUsed: turns,
  wallClockMs: ms,
});

describe("computeBudgetReport", () => {
  it("no limits set: all null, not overBudget, not converging", () => {
    const report = computeBudgetReport(usage(10, 5000, 60000), {});
    expect(report.turnBudget).toBeNull();
    expect(report.wallClockBudgetMs).toBeNull();
    expect(report.overBudget).toBe(false);
    expect(report.converging).toBe(false);
  });

  it("turn budget reached => overBudget", () => {
    const report = computeBudgetReport(usage(20), { turnBudget: 20 });
    expect(report.turnBudgetReached).toBe(true);
    expect(report.remainingTurns).toBe(0);
    expect(report.overBudget).toBe(true);
  });

  it("token usage is statistical and never trips a budget", () => {
    const report = computeBudgetReport(usage(1, 1000), {
      turnBudget: 50,
    });
    expect(report.turnBudgetReached).toBe(false);
    expect(report.overBudget).toBe(false);
  });

  it("active-time budget participates in reached and remaining math", () => {
    const report = computeBudgetReport(usage(1, 100, 60_000), {
      wallClockBudgetMs: 60_000,
    });
    expect(report.wallClockBudgetReached).toBe(true);
    expect(report.remainingWallClockMs).toBe(0);
    expect(report.overBudget).toBe(true);
  });

  it("converging at 75% of any set dimension", () => {
    const report = computeBudgetReport(usage(15), { turnBudget: 20 });
    expect(report.converging).toBe(true);
    expect(report.overBudget).toBe(false);
  });

  it("remaining values clamp at zero", () => {
    const report = computeBudgetReport(usage(25, 0, 0), { turnBudget: 20 });
    expect(report.remainingTurns).toBe(0);
  });
});

describe("isSafetyCapReached", () => {
  it("no turn budget: cap applies at threshold", () => {
    expect(isSafetyCapReached(usage(200), 200)).toBe(true);
    expect(isSafetyCapReached(usage(199), 200)).toBe(false);
  });
});

function resumeSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "g1",
    objective: "finish task",
    status: "paused",
    turnsUsed: 20,
    tokensUsed: 123,
    wallClockMs: 3_600_000,
    budgetLimits: { turnBudget: 20, wallClockBudgetMs: 3_600_000 },
    budget: computeBudgetReport(usage(20, 123, 3_600_000), {
      turnBudget: 20,
      wallClockBudgetMs: 3_600_000,
    }),
    ...overrides,
  };
}

describe("planResume", () => {
  it("merges total limits and leaves the input and cumulative usage intact", () => {
    const snapshot = resumeSnapshot({
      budgetLimits: { turnBudget: 100, wallClockBudgetMs: 7_200_000 },
    });
    expect(planResume(snapshot, { turnBudget: 40 })).toEqual({
      turnBudget: 40,
      wallClockBudgetMs: 7_200_000,
    });
    expect(snapshot.budgetLimits.turnBudget).toBe(100);
    expect(snapshot.turnsUsed).toBe(20);
    expect(snapshot.wallClockMs).toBe(3_600_000);
    expect(planResume(resumeSnapshot({ budgetLimits: {} }))).toEqual({});
  });

  it("enumerates every reached axis and gives an executable two-axis recovery", () => {
    expect(() => planResume(resumeSnapshot())).toThrow(
      expect.objectContaining({ code: "budget_reached" }) as Error,
    );
    try {
      planResume(resumeSnapshot());
    } catch (error) {
      expect((error as Error).message).toContain("20/20");
      expect((error as Error).message).toContain("3600000/3600000");
      expect((error as Error).message).toContain("/goal resume");
      expect((error as Error).message).toContain("both dimensions");
    }
    expect(() => planResume(resumeSnapshot(), { turnBudget: 40 })).toThrow(
      /active time/,
    );
    expect(
      planResume(resumeSnapshot(), {
        turnBudget: 40,
        wallClockBudgetMs: 7_200_000,
      }),
    ).toEqual({ turnBudget: 40, wallClockBudgetMs: 7_200_000 });
  });

  it("rejects equality, illegal totals, and a safety cap that budgets cannot raise", () => {
    expect(() => planResume(resumeSnapshot(), { turnBudget: 20 })).toThrow(
      expect.objectContaining({ code: "budget_reached" }) as Error,
    );
    expect(() => planResume(resumeSnapshot(), { turnBudget: 20.1 })).toThrow(
      expect.objectContaining({ code: "invalid_budget" }) as Error,
    );
    expect(() => planResume(resumeSnapshot({ turnsUsed: 1000 }))).toThrow(
      expect.objectContaining({ code: "safety_cap_reached" }) as Error,
    );
    expect(() => planResume(resumeSnapshot({ turnsUsed: 1000 }))).toThrow(
      /\/goal cancel.*new goal/,
    );
  });
});
