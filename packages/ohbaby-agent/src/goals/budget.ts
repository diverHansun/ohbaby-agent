import {
  GOAL_BUDGET_CONVERGING_RATIO,
  GOAL_SAFETY_CAP_TURNS,
} from "./constants.js";
import type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalSnapshot,
  GoalUsage,
} from "./types.js";
import { validateGoalBudgetLimits } from "./budget-input.js";
import { GoalError } from "./errors.js";

interface DimensionReport {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly reached: boolean;
  readonly ratio: number | null;
}

function reportDimension(
  used: number,
  limit: number | undefined,
): DimensionReport {
  if (limit === undefined || limit <= 0) {
    return { limit: null, ratio: null, reached: false, remaining: null };
  }
  return {
    limit,
    ratio: used / limit,
    reached: used >= limit,
    remaining: Math.max(0, limit - used),
  };
}

export function computeBudgetReport(
  usage: GoalUsage,
  limits: GoalBudgetLimits,
): GoalBudgetReport {
  const turns = reportDimension(usage.turnsUsed, limits.turnBudget);
  const wallClock = reportDimension(
    usage.wallClockMs,
    limits.wallClockBudgetMs,
  );
  const ratios = [turns.ratio, wallClock.ratio].filter(
    (ratio): ratio is number => ratio !== null,
  );
  return {
    converging: ratios.some((ratio) => ratio >= GOAL_BUDGET_CONVERGING_RATIO),
    overBudget: turns.reached || wallClock.reached,
    remainingTurns: turns.remaining,
    remainingWallClockMs: wallClock.remaining,
    turnBudget: turns.limit,
    turnBudgetReached: turns.reached,
    wallClockBudgetMs: wallClock.limit,
    wallClockBudgetReached: wallClock.reached,
  };
}

/** 系统绝对安全阀始终生效，不能被显式 turn budget 绕过。 */
export function isSafetyCapReached(
  usage: GoalUsage,
  safetyCapTurns: number,
): boolean {
  return usage.turnsUsed >= safetyCapTurns;
}

export function planResume(
  snapshot: GoalSnapshot,
  overrides: GoalBudgetLimits = {},
  safetyCapTurns = GOAL_SAFETY_CAP_TURNS,
): GoalBudgetLimits {
  const limits = validateGoalBudgetLimits({
    ...snapshot.budgetLimits,
    ...validateGoalBudgetLimits(overrides),
  });
  if (isSafetyCapReached(snapshot, safetyCapTurns)) {
    throw new GoalError(
      "safety_cap_reached",
      `Safety cap reached: ${String(snapshot.turnsUsed)}/${String(safetyCapTurns)} continuation turns. Run /goal cancel, then create a new goal.`,
    );
  }
  const reached: string[] = [];
  if (
    limits.turnBudget !== undefined &&
    snapshot.turnsUsed >= limits.turnBudget
  ) {
    reached.push(
      `turns used ${String(snapshot.turnsUsed)}/${String(limits.turnBudget)}`,
    );
  }
  if (
    limits.wallClockBudgetMs !== undefined &&
    snapshot.wallClockMs >= limits.wallClockBudgetMs
  ) {
    reached.push(
      `active time used ${String(snapshot.wallClockMs)}/${String(limits.wallClockBudgetMs)} ms`,
    );
  }
  if (reached.length > 0) {
    throw new GoalError(
      "budget_reached",
      `Cannot resume: ${reached.join("; ")}. Provide total limits greater than usage for all reached dimensions; provide both dimensions together when needed, for example /goal resume 100 turns 3h. Usage is not reset. If a maximum total is exhausted, run /goal cancel, then create a new goal.`,
    );
  }
  return limits;
}
