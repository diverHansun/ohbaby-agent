import { describe, expect, it } from "vitest";
import {
  budgetLimitsFromInput,
  parseGoalResumeBudget,
  validateGoalBudgetLimits,
} from "./budget-input.js";

describe("goal budget input", () => {
  it.each([
    ["", {}],
    ["  ", {}],
    ["100 turns", { turnBudget: 100 }],
    ["3h", { wallClockBudgetMs: 10_800_000 }],
    ["100 turns 3h", { turnBudget: 100, wallClockBudgetMs: 10_800_000 }],
    ["3h 100 turns", { turnBudget: 100, wallClockBudgetMs: 10_800_000 }],
    ["1 turn 1 second", { turnBudget: 1, wallClockBudgetMs: 1000 }],
    ["1000ms", { wallClockBudgetMs: 1000 }],
    ["0.5 minutes", { wallClockBudgetMs: 30_000 }],
    [
      "24 hours 1000 turns",
      { turnBudget: 1000, wallClockBudgetMs: 86_400_000 },
    ],
  ])("parses %j without losing either dimension", (input, limits) => {
    expect(parseGoalResumeBudget(input)).toEqual(limits);
  });

  it.each([
    "100 turns 100 turns",
    "1h 2 minutes",
    "100 tokens",
    "turns",
    "100",
    "NaN turns",
    "Infinity seconds",
    "-1 turns",
    "0h",
    "1.5 turns",
    "1001 turns",
    "25h",
    "999ms",
    "100 turns extra",
    "1h 20 turns extra",
    "1h2turns",
    "1h, 20 turns",
    "1e309h",
    "1e2 turns",
  ])("rejects the entire malformed input %j", (input) => {
    expect(() => parseGoalResumeBudget(input)).toThrow(
      expect.objectContaining({ code: "invalid_budget" }) as Error,
    );
  });

  it.each([
    [1.5, "turns"],
    [1001, "turns"],
    [999, "milliseconds"],
    [24.1, "hours"],
    [Infinity, "seconds"],
    [NaN, "turns"],
    [-1, "turns"],
    [0, "turns"],
    [10, "tokens"],
  ])(
    "uses the same strict single dimension rules for tools: %j %j",
    (value, unit) => {
      expect(() => budgetLimitsFromInput(value, unit)).toThrow(
        expect.objectContaining({ code: "invalid_budget" }) as Error,
      );
    },
  );

  it("validates programmatic limits without accepting clearing or invalid boundaries", () => {
    expect(
      validateGoalBudgetLimits({ turnBudget: 1000, wallClockBudgetMs: 1000 }),
    ).toEqual({ turnBudget: 1000, wallClockBudgetMs: 1000 });
    expect(() => validateGoalBudgetLimits({ turnBudget: undefined })).toThrow();
    expect(() =>
      validateGoalBudgetLimits({ wallClockBudgetMs: 999.9 }),
    ).toThrow();
    expect(() => validateGoalBudgetLimits({ turnBudget: 1.1 })).toThrow();
  });
});
