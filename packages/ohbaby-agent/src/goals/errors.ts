export type GoalErrorCode =
  | "no_goal"
  | "goal_exists"
  | "invalid_objective"
  | "invalid_transition";

export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}
