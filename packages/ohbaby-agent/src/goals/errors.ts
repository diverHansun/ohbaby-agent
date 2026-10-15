export type GoalErrorCode =
  | "no_goal"
  | "goal_exists"
  | "invalid_objective"
  | "invalid_criterion"
  | "invalid_transition"
  | "invalid_budget"
  | "budget_reached"
  | "safety_cap_reached";

export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}
