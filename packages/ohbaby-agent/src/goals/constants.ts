/**
 * objective 每轮续跑原文重注入（权威来源是 GoalStore，不是 LLM 复述），
 * 上限要装得下"自包含的目标 + 对话中已达成的关键约束"；这是天花板不是目标，
 * 注入成本随长度线性增长（约 1500-2000 tokens/轮 @ 6000 字符）。
 */
export const MAX_GOAL_OBJECTIVE_LENGTH = 6000;

/** 不可配置的系统绝对安全阀；不是用户预算，不进入 BudgetReport。 */
export const GOAL_SAFETY_CAP_TURNS = 1000;

/** 任一预算维度用量占比达到该阈值时，提醒文本提示模型收敛。 */
export const GOAL_BUDGET_CONVERGING_RATIO = 0.75;

/** 续跑提醒的自审指令核心。 */
export const GOAL_CONTINUATION_CORE = [
  "Continue working toward the active goal.",
  "Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be",
  "decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,",
  "do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`",
  "or `paused` in the same turn. Otherwise, weigh the objective and any completion criteria",
  "against the work done so far. Goal mode is iterative: do one coherent slice of work, then",
  "reassess. Call UpdateGoal with `complete` only when all required work is done, any stated",
  "validation has passed, and there is no useful next action. Do not mark complete after only",
  "producing a plan, summary, first pass, or partial result. If an external condition or required",
  "user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal",
  "with `paused` and a short reason.",
].join(" ");
