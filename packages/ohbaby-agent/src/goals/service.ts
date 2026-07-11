import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";
import { driveGoal } from "./driver.js";
import { GoalStore } from "./store.js";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalChange,
  GoalExecutionControlPort,
  GoalPersistencePort,
  GoalSnapshot,
  GoalStatus,
  GoalTurnRunner,
} from "./types.js";

export interface GoalServiceDeps {
  readonly persistence: GoalPersistencePort;
  readonly now?: () => number;
  readonly createGoalId?: () => string;
  /** 默认 GOAL_SAFETY_CAP_TURNS；仅测试可注入低值，不对用户暴露。 */
  readonly safetyCapTurns?: number;
  readonly executionControl: GoalExecutionControlPort;
  readonly onChange?: (event: {
    readonly sessionId: string;
    readonly snapshot: GoalSnapshot | null;
    readonly change: GoalChange;
  }) => void;
  readonly onError?: (event: {
    readonly error: unknown;
    readonly sessionId: string;
  }) => void;
}

/**
 * goals 模块出口：按 session 管理 GoalStore（懒重建），
 * 拥有 ensureDriving 守卫（恰一个 driver），并作为命令层与 goal 工具的共同后端。
 */
export class GoalService {
  private readonly stores = new Map<string, Promise<GoalStore>>();
  private readonly driving = new Map<string, Promise<void>>();
  private runner: GoalTurnRunner | undefined;
  private readonly safetyCapTurns: number;

  constructor(private readonly deps: GoalServiceDeps) {
    this.safetyCapTurns = deps.safetyCapTurns ?? GOAL_SAFETY_CAP_TURNS;
  }

  /** 幂等：适配层就绪后附着；后设覆盖（测试可替换）。 */
  attachTurnRunner(runner: GoalTurnRunner): void {
    this.runner = runner;
  }

  /** 懒重建 + 缓存；重建自带 active→paused 归一化。 */
  storeFor(sessionId: string): Promise<GoalStore> {
    const existing = this.stores.get(sessionId);
    if (existing !== undefined) return existing;
    const created = GoalStore.rebuild({
      persistence: this.deps.persistence,
      sessionId,
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      ...(this.deps.createGoalId !== undefined
        ? { createGoalId: this.deps.createGoalId }
        : {}),
    }).then((store) => {
      store.onChange = (snapshot, change): void => {
        this.deps.onChange?.({ change, sessionId, snapshot });
      };
      return store;
    });
    this.stores.set(sessionId, created);
    return created;
  }

  /** 确保 active goal 恰有一个 driver 循环在跑（fire-and-forget、幂等）。 */
  ensureDriving(sessionId: string): void {
    if (this.runner === undefined) return;
    if (this.driving.has(sessionId)) return;
    const runner = this.runner;
    const loop = (async (): Promise<void> => {
      const store = await this.storeFor(sessionId);
      await driveGoal({
        pause: (reason, actor) =>
          this.pauseActiveGoal(sessionId, reason, actor),
        runner,
        safetyCapTurns: this.safetyCapTurns,
        sessionId,
        store,
      });
    })()
      .catch(async (error: unknown) => {
        this.deps.onError?.({ error, sessionId });
        const store = await this.storeFor(sessionId).catch(() => undefined);
        if (store?.getSnapshot()?.status === "active") {
          await this.pauseActiveGoal(
            sessionId,
            `runtime error: ${errorMessage(error)}`,
            "runtime",
          ).catch(() => undefined);
        }
      })
      .finally(() => {
        this.driving.delete(sessionId);
      });
    this.driving.set(sessionId, loop);
  }

  /** 测试与收尾用：等待当前 driver 循环退出（无循环则立即返回）。 */
  async whenIdle(sessionId: string): Promise<void> {
    await (this.driving.get(sessionId) ?? Promise.resolve());
  }

  async createGoal(
    sessionId: string,
    input: CreateGoalInput,
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const snapshot = await store.create(input);
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async resumeGoal(sessionId: string): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const snapshot = await store.resume("user");
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async pauseGoal(
    sessionId: string,
    reason = "Paused by user",
  ): Promise<GoalSnapshot> {
    return this.pauseActiveGoal(sessionId, reason, "user");
  }

  async cancelGoal(sessionId: string): Promise<void> {
    const store = await this.storeFor(sessionId);
    const wasActive = store.getSnapshot()?.status === "active";
    await store.cancel("user");
    if (wasActive) {
      await this.interruptGoalExecution(sessionId, "goal cancelled", true);
    }
  }

  async replaceGoal(
    sessionId: string,
    objective: string,
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    return store.replaceObjective(objective, "user");
  }

  async setBudget(
    sessionId: string,
    limits: GoalBudgetLimits,
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    return store.setBudgetLimits(limits, "model");
  }

  async getSnapshot(sessionId: string): Promise<GoalSnapshot | null> {
    const store = await this.storeFor(sessionId);
    return store.getSnapshot();
  }

  /**
   * 模型经 UpdateGoal 的唯一杠杆。恢复只有 `/goal resume` 一条路：
   * 对 paused 的 goal 传 "active" 不迁移、不起 driver，只返回引导语。
   */
  async updateGoalFromModel(
    sessionId: string,
    status: GoalStatus,
    reason?: string,
  ): Promise<{
    readonly snapshot: GoalSnapshot | null;
    readonly note: string;
  }> {
    const store = await this.storeFor(sessionId);
    const current = store.getSnapshot();
    if (status !== "active" && current?.status !== "active") {
      return {
        note: inactiveGoalNote(current),
        snapshot: current,
      };
    }
    if (status === "complete") {
      await store.markComplete("model");
      await this.interruptGoalExecution(sessionId, "goal completed", false);
      return { note: "Goal completed and cleared.", snapshot: null };
    }
    if (status === "paused") {
      const snapshot = await this.pauseActiveGoal(
        sessionId,
        reason ?? "Paused by model",
        "model",
      );
      return {
        note: `Goal paused: ${snapshot.pauseReason ?? ""}`,
        snapshot,
      };
    }
    if (current === null) {
      return { note: "No goal is currently set.", snapshot: null };
    }
    if (current.status === "active") {
      return { note: "Goal is already active.", snapshot: current };
    }
    return {
      note: inactiveGoalNote(current),
      snapshot: current,
    };
  }

  private async pauseActiveGoal(
    sessionId: string,
    reason: string,
    actor: GoalActor,
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const wasActive = store.getSnapshot()?.status === "active";
    const snapshot = await store.pause(reason, actor);
    if (wasActive) {
      await this.interruptGoalExecution(sessionId, reason, true);
    }
    return snapshot;
  }

  private async interruptGoalExecution(
    sessionId: string,
    reason: string,
    includePrimary: boolean,
  ): Promise<void> {
    await this.deps.executionControl.interruptGoalExecution({
      includePrimary,
      reason,
      sessionId,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inactiveGoalNote(snapshot: GoalSnapshot | null): string {
  if (snapshot === null) {
    return "No goal is currently set.";
  }
  return `Goal is ${snapshot.status}. Ask the user to run /goal resume to continue it.`;
}
