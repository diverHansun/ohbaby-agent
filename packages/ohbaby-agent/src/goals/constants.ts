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
  "decided. If the objective is already fulfilled, call UpdateGoal with `complete` in the same",
  "turn. If it is impossible, unsafe, or contradictory, report the blocker as described below.",
  "Otherwise, weigh the objective and any completion criteria",
  "against the work done so far. Goal mode is iterative: do one coherent slice of work, then",
  "reassess. For a complex goal, use and maintain a Todo list of meaningful milestones across",
  "continuation turns. If a Todo list was used, reconcile it before completion without treating",
  "it as a runtime gate. Call UpdateGoal with `complete` only when all required work is done, any",
  "stated validation has passed, and there is no useful next action. Do not mark complete after only",
  "producing a plan, summary, first pass, or partial result. If an external condition or required",
  "user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal",
  "with `blocked` and a nonblank reason once on each genuinely blocked turn. The backend counts",
  "consecutive eligible goal turns with the same reason: 1/3 and 2/3 remain active, so continue",
  "useful independent work. The backend marks the third eligible turn blocked. A paused or blocked",
  "goal resumes only when the user runs /goal resume.",
].join(" ");
