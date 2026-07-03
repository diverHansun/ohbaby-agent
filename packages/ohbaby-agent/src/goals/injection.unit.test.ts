import { describe, expect, it } from "vitest";
import { computeBudgetReport } from "./budget.js";
import { formatGoalStatusLines, renderGoalTurnPrompt } from "./injection.js";
import type { GoalSnapshot } from "./types.js";

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  const usage = { tokensUsed: 0, turnsUsed: 1, wallClockMs: 0 };
  return {
    budget: computeBudgetReport(usage, {}),
    budgetLimits: {},
    goalId: "g1",
    objective: "fix the failing checkout tests",
    status: "active",
    tokensUsed: usage.tokensUsed,
    turnsUsed: usage.turnsUsed,
    wallClockMs: usage.wallClockMs,
    ...overrides,
  };
}

describe("renderGoalTurnPrompt", () => {
  it("first turn embeds objective inside untrusted wrapper", () => {
    const prompt = renderGoalTurnPrompt(snapshot(), { isFirstTurn: true });
    expect(prompt).toContain("<untrusted_objective>");
    expect(prompt).toContain("fix the failing checkout tests");
    expect(prompt).toContain("UpdateGoal");
  });

  it("continuation turn includes progress and self-audit core", () => {
    const prompt = renderGoalTurnPrompt(snapshot({ turnsUsed: 3 }), {
      isFirstTurn: false,
    });
    expect(prompt).toContain("Continue working toward the active goal.");
    expect(prompt).toContain("3");
  });

  it("includes completion criterion when present", () => {
    const prompt = renderGoalTurnPrompt(
      snapshot({ completionCriterion: "checkout suite passes" }),
      { isFirstTurn: true },
    );
    expect(prompt).toContain("<untrusted_completion_criterion>");
  });

  it("omits budget lines when no budget set; includes them when set", () => {
    const without = renderGoalTurnPrompt(snapshot(), { isFirstTurn: false });
    expect(without).not.toContain("Budget");
    const usage = { tokensUsed: 0, turnsUsed: 8, wallClockMs: 0 };
    const withBudget = renderGoalTurnPrompt(
      snapshot({
        budget: computeBudgetReport(usage, { turnBudget: 10 }),
        budgetLimits: { turnBudget: 10 },
        turnsUsed: 8,
      }),
      { isFirstTurn: false },
    );
    expect(withBudget).toContain("Budget");
    expect(withBudget).toContain("start converging");
  });
});

describe("formatGoalStatusLines", () => {
  it("shows status, objective and usage", () => {
    const lines = formatGoalStatusLines(
      snapshot({ status: "paused", terminalReason: "interrupted" }),
    );
    const text = lines.join("\n");
    expect(text).toContain("paused");
    expect(text).toContain("interrupted");
    expect(text).toContain("fix the failing checkout tests");
  });
});
