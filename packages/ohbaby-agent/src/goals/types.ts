export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type GoalActor = "user" | "model" | "runtime" | "system";

export interface GoalBudgetLimits {
  readonly turnBudget?: number;
  readonly tokenBudget?: number;
  readonly wallClockBudgetMs?: number;
}

export interface GoalUsage {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export interface GoalBudgetReport {
  readonly turnBudget: number | null;
  readonly tokenBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTurns: number | null;
  readonly remainingTokens: number | null;
  readonly remainingWallClockMs: number | null;
  readonly turnBudgetReached: boolean;
  readonly tokenBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
  /** 任一已设维度用量占比 >= GOAL_BUDGET_CONVERGING_RATIO */
  readonly converging: boolean;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budgetLimits: GoalBudgetLimits;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
}

export type GoalChangeKind = "created" | "lifecycle" | "completion";

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly actor?: GoalActor;
}

export type GoalRecordType = "create" | "update" | "clear";

/** 追加式持久化记录的负载（JSON 存储）。 */
export interface GoalRecordData {
  readonly type: GoalRecordType;
  readonly goalId: string;
  readonly objective?: string;
  readonly completionCriterion?: string;
  readonly status?: GoalStatus;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly reason?: string;
  readonly actor?: GoalActor;
}

export interface GoalRecord extends GoalRecordData {
  readonly sessionId: string;
  readonly seq: number;
  readonly createdAt: number;
}

/** 持久化端口：追加记录 + 按 session 顺序读取（重建用）。 */
export interface GoalPersistencePort {
  append(sessionId: string, data: GoalRecordData): Promise<void>;
  list(sessionId: string): Promise<readonly GoalRecord[]>;
}

/** 一轮续跑 Run 的结果（driver 唯一消费的执行层信号）。 */
export interface GoalTurnOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly error?: string;
  /** 本轮消耗 token（best-effort；不可得时省略，token 预算即不推进）。 */
  readonly tokensUsed?: number;
}

/** 适配层实现：把提醒文本作为 user 消息起一轮 Run 并等待完成。 */
export interface GoalTurnRunner {
  runTurn(sessionId: string, promptText: string): Promise<GoalTurnOutcome>;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly replace?: boolean;
  readonly actor: GoalActor;
}
