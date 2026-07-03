export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

/** 不可配置安全阀：未设 turn 预算时的续跑轮上限（不对用户/prompt 暴露）。 */
export const GOAL_SAFETY_CAP_TURNS = 200;

/** 任一预算维度用量占比达到该阈值时，提醒文本提示模型收敛。 */
export const GOAL_BUDGET_CONVERGING_RATIO = 0.75;

/** 续跑提醒的自审指令核心。 */
export const GOAL_CONTINUATION_CORE = [
  "Continue working toward the active goal.",
  "Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be",
  "decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,",
  "do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`",
  "or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria",
  "against the work done so far. Goal mode is iterative: do one coherent slice of work, then",
  "reassess. Call UpdateGoal with `complete` only when all required work is done, any stated",
  "validation has passed, and there is no useful next action. Do not mark complete after only",
  "producing a plan, summary, first pass, or partial result. If an external condition or required",
  "user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal",
  "with `blocked`.",
].join(" ");
