import { describe, expect, it } from "vitest";
import { computeBudgetReport, isSafetyCapReached } from "./budget.js";

const usage = (turns: number, tokens = 0, ms = 0) => ({
  turnsUsed: turns,
  tokensUsed: tokens,
  wallClockMs: ms,
});

describe("computeBudgetReport", () => {
  it("no limits set: all null, not overBudget, not converging", () => {
    const report = computeBudgetReport(usage(10, 5000, 60000), {});
    expect(report.turnBudget).toBeNull();
    expect(report.tokenBudget).toBeNull();
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

  it("dimensions are independent: token over, turn under", () => {
    const report = computeBudgetReport(usage(1, 1000), {
      turnBudget: 50,
      tokenBudget: 800,
    });
    expect(report.tokenBudgetReached).toBe(true);
    expect(report.turnBudgetReached).toBe(false);
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

  it("wall-clock budget reached", () => {
    const report = computeBudgetReport(usage(1, 0, 120000), {
      wallClockBudgetMs: 100000,
    });
    expect(report.wallClockBudgetReached).toBe(true);
    expect(report.overBudget).toBe(true);
  });
});

describe("isSafetyCapReached", () => {
  it("no turn budget: cap applies at threshold", () => {
    expect(isSafetyCapReached(usage(200), {}, 200)).toBe(true);
    expect(isSafetyCapReached(usage(199), {}, 200)).toBe(false);
  });

  it("turn budget set: safety cap never applies (user budget wins)", () => {
    expect(isSafetyCapReached(usage(500), { turnBudget: 1000 }, 200)).toBe(
      false,
    );
  });
});
