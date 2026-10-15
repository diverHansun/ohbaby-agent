import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";
import { GoalError } from "./errors.js";
import type { GoalBudgetLimits } from "./types.js";

export const GOAL_BUDGET_UNITS = [
  "turns",
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
] as const;

const TIME_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

/** Commands and tools share the same single-dimension validation. */
export function budgetLimitsFromInput(
  value: unknown,
  unit: unknown,
): GoalBudgetLimits {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new GoalError(
      "invalid_budget",
      "Invalid budget: expected a finite positive number.",
    );
  }
  if (unit === "turn" || unit === "turns") {
    if (!Number.isInteger(value) || value > GOAL_SAFETY_CAP_TURNS) {
      throw new GoalError(
        "invalid_budget",
        `Invalid turn budget: expected a positive integer; system safety cap is ${String(GOAL_SAFETY_CAP_TURNS)} turns.`,
      );
    }
    return { turnBudget: value };
  }
  const factor =
    typeof unit === "string" && Object.hasOwn(TIME_FACTORS, unit)
      ? TIME_FACTORS[unit]
      : undefined;
  if (factor === undefined) {
    throw new GoalError(
      "invalid_budget",
      "Invalid unit for goal budget: use turns, milliseconds, seconds, minutes, or hours.",
    );
  }
  const wallClockBudgetMs = value * factor;
  if (
    !Number.isFinite(wallClockBudgetMs) ||
    wallClockBudgetMs < 1000 ||
    wallClockBudgetMs > 86_400_000
  ) {
    throw new GoalError(
      "invalid_budget",
      "Invalid time budget: expected a duration from 1 second to 24 hours.",
    );
  }
  return { wallClockBudgetMs };
}

/** Validate explicit fields; undefined is not a syntax for clearing a limit. */
export function validateGoalBudgetLimits(
  limits: GoalBudgetLimits,
): GoalBudgetLimits {
  let validated: GoalBudgetLimits = {};
  for (const [key, value] of Object.entries(limits)) {
    if (key !== "turnBudget" && key !== "wallClockBudgetMs") {
      throw new GoalError(
        "invalid_budget",
        `Invalid budget dimension: ${key}.`,
      );
    }
    validated = {
      ...validated,
      ...budgetLimitsFromInput(
        value,
        key === "turnBudget" ? "turns" : "milliseconds",
      ),
    };
  }
  return validated;
}

/** Parse zero, one, or two dimensions, consuming every character. */
export function parseGoalResumeBudget(input: string): GoalBudgetLimits {
  let rest = input.trim();
  let limits: GoalBudgetLimits = {};
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]+)(?=\s|$)/i.exec(rest);
    if (match === null) {
      throw new GoalError(
        "invalid_budget",
        "Invalid resume budget. Use /goal resume 100 turns 3h; each limit needs a value and unit, without extra arguments.",
      );
    }
    const dimension = budgetLimitsFromInput(
      Number(match[1]),
      match[2].toLowerCase(),
    );
    const key =
      dimension.turnBudget !== undefined ? "turnBudget" : "wallClockBudgetMs";
    if (Object.hasOwn(limits, key)) {
      throw new GoalError(
        "invalid_budget",
        `Duplicate budget dimension: ${key === "turnBudget" ? "turns" : "active time"}. Provide each dimension once.`,
      );
    }
    limits = { ...limits, ...dimension };
    rest = rest.slice(match[0].length).trimStart();
  }
  return limits;
}
