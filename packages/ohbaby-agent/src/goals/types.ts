export type GoalStatus = "active" | "paused" | "complete";
export type GoalStoredStatus = GoalStatus | "blocked";
export type GoalActor = "user" | "model" | "runtime" | "system";

export interface GoalBudgetLimits {
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

export interface GoalUsage {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly cachedTokensUsed?: number;
  readonly usageIncomplete?: boolean;
  readonly wallClockMs: number;
}

export interface GoalBudgetReport {
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly turnBudgetReached: boolean;
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
  readonly cachedTokensUsed?: number;
  readonly usageIncomplete?: boolean;
  readonly wallClockMs: number;
  readonly budgetLimits: GoalBudgetLimits;
  readonly budget: GoalBudgetReport;
  readonly pauseReason?: string;
}

export type GoalChangeKind =
  | "created"
  | "lifecycle"
  | "completion"
  | "progress";

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly pauseReason?: string;
  readonly actor?: GoalActor;
}

export type GoalRecordType = "create" | "update" | "clear";

/** 追加式持久化记录的负载（JSON 存储）。 */
export interface GoalRecordData {
  readonly type: GoalRecordType;
  readonly goalId: string;
  readonly objective?: string;
  readonly completionCriterion?: string;
  readonly status?: GoalStoredStatus;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly cachedTokensUsed?: number;
  readonly usageIncomplete?: boolean;
  readonly wallClockMs?: number;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly pauseReason?: string;
  /** Legacy records used `reason`; replay normalizes it into pauseReason. */
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
  readonly status: "succeeded" | "failed" | "cancelled" | "not_admitted";
  readonly ticket?: GoalTurnTicket;
  readonly release?: () => void;
  readonly error?: string;
  readonly usage?: {
    readonly totalTokens?: number;
    readonly cachedInputTokens?: number;
    readonly usageComplete: boolean;
  };
}

/** 适配层实现：把提醒文本作为 user 消息起一轮 Run 并等待完成。 */
export interface GoalTurnRunner {
  finishTurn?(
    sessionId: string,
    ticket: GoalTurnTicket,
    outcome: GoalTurnOutcome,
  ): Promise<void>;
  runTurn(
    sessionId: string,
    goalId: string,
    executionEpoch: number,
  ): Promise<GoalTurnOutcome>;
}

export interface GoalExecutionInterruptInput {
  readonly sessionId: string;
  readonly reason: string;
  /** Complete lets the current main run finish its final response. */
  readonly includePrimary: boolean;
  readonly ticket?: GoalTurnTicket;
  readonly expectedRunId?: string;
}

export interface GoalExecutionControlPort {
  interruptGoalExecution(input: GoalExecutionInterruptInput): Promise<void>;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly replace?: boolean;
  readonly actor: GoalActor;
}

/** In-memory admission identity; never serialized into a model tool schema. */
export interface GoalTurnTicket {
  readonly goalId: string;
  readonly executionEpoch: number;
  readonly turnNumber: number;
  readonly modelText: string;
  readonly displayText: string;
  readonly token: symbol;
  readonly controller: AbortController;
  recoveryPending?: boolean;
  stopIntent?: { readonly reason: string; readonly includePrimary: boolean };
  runId?: string;
  settled: boolean;
}

export type GoalMutationContext =
  | { readonly kind: "user" }
  | { readonly kind: "goal"; readonly ticket: GoalTurnTicket }
  | { readonly kind: "invalid" };
