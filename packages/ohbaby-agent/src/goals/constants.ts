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
  "Keep the self-audit brief. The full objective and agreed constraints persist across turns;",
  "do not narrow success to the subset already done. Use current workspace state and tool",
  "results, not earlier narration alone, to advance the next required work. Do not repeat",
  "completed work or invent extra scope. For a complex goal, use and maintain a Todo list of",
  "meaningful milestones across continuation turns. If a Todo list was used, reconcile it before completion without treating",
  "it as a runtime gate. Before completion, match every requirement and any completion criterion",
  "to current evidence; validation must cover what you claim. Once all required work is done and",
  "validated—and only then—call UpdateGoal with `complete` in this turn, give the final answer,",
  "and do not start new work. A partial result is insufficient, and a plan alone is insufficient",
  "unless the requested deliverable is a plan. If work remains and progress is possible, keep working;",
  "leave the goal active when the turn ends normally so the runtime can continue. Do not infer a",
  "blocker from size, difficulty, slow progress, pending validation, or a single failed attempt.",
  "Resolve questions answerable from the workspace yourself. If an external condition or required",
  "user input prevents progress, or the objective",
  "is impossible, unsafe, or contradictory, call UpdateGoal with `blocked` and a nonblank reason",
  "once on each genuinely blocked turn. Reuse the same concise reason verbatim (without turn or",
  "attempt counts) while the blocking condition is unchanged. The backend counts consecutive",
  "eligible goal turns with the same reason: 1/3 and 2/3 remain active, so continue any useful",
  "independent work or end the turn cleanly. The backend marks the third eligible turn blocked.",
  "A paused or blocked goal resumes only when the user runs /goal resume.",
].join(" ");
