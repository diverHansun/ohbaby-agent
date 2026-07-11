import { GOAL_BUDGET_CONVERGING_RATIO } from "./constants.js";
import type { GoalBudgetLimits, GoalBudgetReport, GoalUsage } from "./types.js";

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
  const tokens = reportDimension(usage.tokensUsed, limits.tokenBudget);
  const wallClock = reportDimension(
    usage.wallClockMs,
    limits.wallClockBudgetMs,
  );
  const ratios = [turns.ratio, tokens.ratio, wallClock.ratio].filter(
    (ratio): ratio is number => ratio !== null,
  );
  return {
    converging: ratios.some((ratio) => ratio >= GOAL_BUDGET_CONVERGING_RATIO),
    overBudget: turns.reached || tokens.reached || wallClock.reached,
    remainingTokens: tokens.remaining,
    remainingTurns: turns.remaining,
    remainingWallClockMs: wallClock.remaining,
    tokenBudget: tokens.limit,
    tokenBudgetReached: tokens.reached,
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
