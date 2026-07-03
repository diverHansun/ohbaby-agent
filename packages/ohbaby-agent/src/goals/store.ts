import { randomUUID } from "node:crypto";
import { computeBudgetReport } from "./budget.js";
import { MAX_GOAL_OBJECTIVE_LENGTH } from "./constants.js";
import { GoalError } from "./errors.js";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalChange,
  GoalPersistencePort,
  GoalRecordData,
  GoalSnapshot,
  GoalStatus,
} from "./types.js";

export interface GoalStoreDeps {
  readonly sessionId: string;
  readonly persistence: GoalPersistencePort;
  readonly now?: () => number;
  readonly createGoalId?: () => string;
}

interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  /** 已折算的 active 区间累计时长；不含当前 active 区间的实时部分。 */
  wallClockMs: number;
  /** 当前 active 区间的起点（非 active 时为 undefined）。 */
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
}

const RESUME_NORMALIZE_REASON = "Paused after agent resume";

/**
 * 单个 session 的 goal 聚合根：所有状态迁移的唯一入口。
 * 迁移先 append 持久化记录、成功后才改内存（落盘失败显性抛出、内存不变）。
 */
export class GoalStore {
  private state: GoalState | undefined;

  /** UI/服务层订阅点：每次迁移后收到快照与变更描述。 */
  onChange?: (snapshot: GoalSnapshot | null, change: GoalChange) => void;

  private constructor(private readonly deps: GoalStoreDeps) {}

  /** 从持久化记录回放重建，并执行恢复归一化（active 降级 paused）。 */
  static async rebuild(deps: GoalStoreDeps): Promise<GoalStore> {
    const store = new GoalStore(deps);
    const records = await deps.persistence.list(deps.sessionId);
    for (const record of records) {
      if (record.type === "create") {
        store.state = {
          budgetLimits: record.budgetLimits ?? {},
          goalId: record.goalId,
          objective: record.objective ?? "",
          status: "active",
          tokensUsed: 0,
          turnsUsed: 0,
          wallClockMs: 0,
          ...(record.completionCriterion !== undefined
            ? { completionCriterion: record.completionCriterion }
            : {}),
        };
        continue;
      }
      if (record.type === "clear") {
        store.state = undefined;
        continue;
      }
      const state = store.state;
      if (state === undefined) continue;
      if (record.objective !== undefined) state.objective = record.objective;
      if (record.completionCriterion !== undefined) {
        state.completionCriterion = record.completionCriterion;
      }
      if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
      if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
      if (record.wallClockMs !== undefined) {
        state.wallClockMs = record.wallClockMs;
      }
      if (record.budgetLimits !== undefined) {
        state.budgetLimits = record.budgetLimits;
      }
      if (record.status !== undefined) {
        state.status = record.status;
        state.terminalReason =
          record.status === "active" ? undefined : record.reason;
      }
    }
    await store.normalizeAfterReplay();
    return store;
  }

  getSnapshot(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined) return null;
    return this.toSnapshot(state);
  }

  async create(input: CreateGoalInput): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new GoalError(
        "invalid_objective",
        "Goal objective must not be empty.",
      );
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new GoalError(
        "invalid_objective",
        `Goal objective cannot exceed ${String(MAX_GOAL_OBJECTIVE_LENGTH)} characters.`,
      );
    }
    if (this.state !== undefined && input.replace !== true) {
      throw new GoalError(
        "goal_exists",
        "A goal already exists for this session. Use replace to start a new one.",
      );
    }
    const goalId = this.deps.createGoalId?.() ?? randomUUID();
    const record: GoalRecordData = {
      actor: input.actor,
      goalId,
      objective,
      type: "create",
      ...(input.completionCriterion !== undefined
        ? { completionCriterion: input.completionCriterion }
        : {}),
      ...(input.budgetLimits !== undefined
        ? { budgetLimits: input.budgetLimits }
        : {}),
    };
    await this.appendRecord(record);
    this.state = {
      budgetLimits: input.budgetLimits ?? {},
      goalId,
      objective,
      status: "active",
      tokensUsed: 0,
      turnsUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: this.now(),
      ...(input.completionCriterion !== undefined
        ? { completionCriterion: input.completionCriterion }
        : {}),
    };
    const snapshot = this.toSnapshot(this.state);
    this.onChange?.(snapshot, { actor: input.actor, kind: "created" });
    return snapshot;
  }

  async resume(actor: GoalActor): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === "active") return this.toSnapshot(state);
    return this.applyUpdate({ status: "active" }, actor, {
      actor,
      kind: "lifecycle",
      status: "active",
    });
  }

  async pause(reason: string, actor: GoalActor): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status !== "active") return this.toSnapshot(state);
    return this.applyUpdate({ reason, status: "paused" }, actor, {
      actor,
      kind: "lifecycle",
      reason,
      status: "paused",
    });
  }

  async markBlocked(reason: string, actor: GoalActor): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status !== "active") return this.toSnapshot(state);
    return this.applyUpdate({ reason, status: "blocked" }, actor, {
      actor,
      kind: "lifecycle",
      reason,
      status: "blocked",
    });
  }

  /** 宣告成功后立即清除记录——complete 从不作为驻留状态落盘。 */
  async markComplete(actor: GoalActor): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status !== "active") return this.toSnapshot(state);
    this.foldWallClock(state);
    const finalSnapshot: GoalSnapshot = {
      ...this.toSnapshot(state),
      status: "complete",
    };
    await this.appendRecord({ goalId: state.goalId, type: "clear" });
    this.state = undefined;
    this.onChange?.(finalSnapshot, {
      actor,
      kind: "completion",
      status: "complete",
    });
    return finalSnapshot;
  }

  async cancel(actor: GoalActor): Promise<void> {
    const state = this.state;
    if (state === undefined) return;
    await this.appendRecord({ actor, goalId: state.goalId, type: "clear" });
    this.state = undefined;
    this.onChange?.(null, { actor, kind: "lifecycle" });
  }

  async replaceObjective(
    objective: string,
    actor: GoalActor,
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    const trimmed = objective.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new GoalError(
        "invalid_objective",
        "Invalid replacement objective.",
      );
    }
    await this.appendRecord({
      actor,
      goalId: state.goalId,
      objective: trimmed,
      type: "update",
    });
    state.objective = trimmed;
    const snapshot = this.toSnapshot(state);
    this.onChange?.(snapshot, { actor, kind: "lifecycle" });
    return snapshot;
  }

  /** 仅 active 时计数；把"模型宣告 complete 的那一轮"也计入统计。 */
  async incrementTurn(): Promise<void> {
    const state = this.state;
    if (state?.status !== "active") return;
    await this.appendRecord({
      goalId: state.goalId,
      turnsUsed: state.turnsUsed + 1,
      type: "update",
    });
    state.turnsUsed += 1;
  }

  async recordTokenUsage(tokens: number): Promise<void> {
    const state = this.state;
    if (state?.status !== "active" || tokens <= 0) return;
    await this.appendRecord({
      goalId: state.goalId,
      tokensUsed: state.tokensUsed + tokens,
      type: "update",
    });
    state.tokensUsed += tokens;
  }

  async setBudgetLimits(
    limits: GoalBudgetLimits,
    actor: GoalActor,
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    const mergedLimits = { ...state.budgetLimits, ...limits };
    await this.appendRecord({
      actor,
      budgetLimits: mergedLimits,
      goalId: state.goalId,
      type: "update",
    });
    state.budgetLimits = mergedLimits;
    const snapshot = this.toSnapshot(state);
    this.onChange?.(snapshot, { actor, kind: "lifecycle" });
    return snapshot;
  }

  /** 恢复归一化：进程内驱动已不存在，active 只能安全降级为 paused。 */
  private async normalizeAfterReplay(): Promise<void> {
    const state = this.state;
    if (state === undefined) return;
    state.wallClockResumedAt = undefined;
    if (state.status === "active") {
      await this.applyUpdate(
        { reason: RESUME_NORMALIZE_REASON, status: "paused" },
        "runtime",
        {
          kind: "lifecycle",
          reason: RESUME_NORMALIZE_REASON,
          status: "paused",
        },
      );
      return;
    }
    if (state.status === "complete") {
      // complete 是瞬态，落盘残留说明 clear 没写成，补清。
      await this.appendRecord({ goalId: state.goalId, type: "clear" });
      this.state = undefined;
    }
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new GoalError(
        "no_goal",
        "No goal is currently set for this session.",
      );
    }
    return state;
  }

  /** 状态迁移的统一落点：折算 wall-clock → append → 改内存 → 通知。 */
  private async applyUpdate(
    update: { readonly status: GoalStatus; readonly reason?: string },
    actor: GoalActor,
    change: GoalChange,
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === "active" && update.status !== "active") {
      this.foldWallClock(state);
    }
    await this.appendRecord({
      actor,
      goalId: state.goalId,
      type: "update",
      wallClockMs: state.wallClockMs,
      ...(update.reason !== undefined ? { reason: update.reason } : {}),
      status: update.status,
    });
    state.status = update.status;
    state.terminalReason =
      update.status === "active" ? undefined : update.reason;
    if (update.status === "active") {
      state.wallClockResumedAt = this.now();
    }
    const snapshot = this.toSnapshot(state);
    this.onChange?.(snapshot, change);
    return snapshot;
  }

  private appendRecord(data: GoalRecordData): Promise<void> {
    return this.deps.persistence.append(this.deps.sessionId, data);
  }

  private foldWallClock(state: GoalState): void {
    if (state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, this.now() - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
  }

  private liveWallClockMs(state: GoalState): number {
    if (state.status === "active" && state.wallClockResumedAt !== undefined) {
      return (
        state.wallClockMs + Math.max(0, this.now() - state.wallClockResumedAt)
      );
    }
    return state.wallClockMs;
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    const wallClockMs = this.liveWallClockMs(state);
    const usage = {
      tokensUsed: state.tokensUsed,
      turnsUsed: state.turnsUsed,
      wallClockMs,
    };
    return {
      budget: computeBudgetReport(usage, state.budgetLimits),
      budgetLimits: { ...state.budgetLimits },
      goalId: state.goalId,
      objective: state.objective,
      status: state.status,
      tokensUsed: state.tokensUsed,
      turnsUsed: state.turnsUsed,
      wallClockMs,
      ...(state.completionCriterion !== undefined
        ? { completionCriterion: state.completionCriterion }
        : {}),
      ...(state.terminalReason !== undefined
        ? { terminalReason: state.terminalReason }
        : {}),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
