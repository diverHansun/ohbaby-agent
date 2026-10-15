import { renderGoalTurnPrompt } from "./injection.js";
import { GoalError } from "./errors.js";
import { GOAL_SAFETY_CAP_TURNS } from "./constants.js";
import { driveGoal } from "./driver.js";
import { GoalStore } from "./store.js";
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalChange,
  GoalExecutionControlPort,
  GoalExecutionInterruptInput,
  GoalPersistencePort,
  GoalSnapshot,
  GoalStatus,
  GoalTurnRunner,
  GoalTurnTicket,
  GoalTurnOutcome,
  GoalMutationContext,
} from "./types.js";

export interface GoalServiceDeps {
  readonly persistence: GoalPersistencePort;
  readonly withSessionMutation?: <T>(
    sessionId: string,
    op: () => Promise<T>,
  ) => Promise<T>;
  readonly resolveMutationContext?: (
    sessionId: string,
    runId: string,
  ) => GoalMutationContext;
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
  private readonly initializedStores = new Map<string, GoalStore>();
  private readonly driving = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private readonly tickets = new Map<string, Set<GoalTurnTicket>>();
  private readonly requested = new Set<string>();
  private runner: GoalTurnRunner | undefined;
  private readonly safetyCapTurns: number;

  constructor(private readonly deps: GoalServiceDeps) {
    this.safetyCapTurns = deps.safetyCapTurns ?? GOAL_SAFETY_CAP_TURNS;
  }

  /** 幂等：适配层就绪后附着；后设覆盖（测试可替换）。 */
  attachTurnRunner(runner: GoalTurnRunner): void {
    this.runner = runner;
  }

  /** Explicit recovery boundary; repeated initialization never replays live goals. */
  async initSession(sessionId: string): Promise<void> {
    await this.storeFor(sessionId);
  }

  /** Undefined means recovery has not completed; null means an initialized empty goal. */
  peekSnapshot(sessionId: string): GoalSnapshot | null | undefined {
    return this.initializedStores.get(sessionId)?.getSnapshot();
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
    })
      .then((store) => {
        store.onChange = (snapshot, change): void => {
          this.deps.onChange?.({ change, sessionId, snapshot });
        };
        this.initializedStores.set(sessionId, store);
        return store;
      })
      .catch((error: unknown) => {
        this.stores.delete(sessionId);
        throw error;
      });
    this.stores.set(sessionId, created);
    return created;
  }

  currentExecutionEpoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }

  isExecutionCurrent(
    sessionId: string,
    goalId: string,
    epoch: number,
  ): boolean {
    const snapshot = this.peekSnapshot(sessionId);
    return (
      snapshot?.goalId === goalId &&
      snapshot.status === "active" &&
      this.currentExecutionEpoch(sessionId) === epoch
    );
  }

  getTicketForRun(
    sessionId: string,
    runId: string,
  ): GoalTurnTicket | undefined {
    return [...(this.tickets.get(sessionId) ?? [])].find(
      (ticket) => ticket.runId === runId,
    );
  }

  bindTicketRun(ticket: GoalTurnTicket, runId: string): void {
    ticket.runId = runId;
  }

  /** Caller already owns the session mutation boundary; never enters it again. */
  async admitTurnInBoundary(
    sessionId: string,
    goalId: string,
    epoch: number,
    available = true,
  ): Promise<GoalTurnTicket | null> {
    if (!this.isExecutionCurrent(sessionId, goalId, epoch)) return null;
    const store = this.initializedStores.get(sessionId);
    const before = store?.getSnapshot();
    if (store === undefined || before === undefined || before === null)
      return null;
    if (before.budget.overBudget || before.turnsUsed >= this.safetyCapTurns) {
      await store.pause(
        before.budget.overBudget
          ? "A configured budget was reached"
          : "Safety cap reached: too many continuation turns without completion",
        "runtime",
      );
      this.invalidate(sessionId);
      return null;
    }
    if (!available) return null;
    await store.incrementTurn();
    const snapshot = store.getSnapshot();
    if (snapshot === null)
      throw new Error("Admitted goal disappeared inside its session boundary.");
    const ticket: GoalTurnTicket = {
      goalId,
      executionEpoch: epoch,
      turnNumber: snapshot.turnsUsed,
      modelText: renderGoalTurnPrompt(snapshot, {
        isFirstTurn: snapshot.turnsUsed === 1,
      }),
      displayText:
        snapshot.turnsUsed === 1
          ? "Goal started"
          : `Goal auto-continue (turn ${String(snapshot.turnsUsed)})`,
      token: Symbol("goal-turn"),
      controller: new AbortController(),
      settled: false,
    };
    const tickets = this.tickets.get(sessionId) ?? new Set<GoalTurnTicket>();
    tickets.add(ticket);
    this.tickets.set(sessionId, tickets);
    return ticket;
  }

  async settleTurn(
    sessionId: string,
    ticket: GoalTurnTicket,
    outcome: GoalTurnOutcome,
  ): Promise<void> {
    const store = await this.storeFor(sessionId);
    await this.mutate(sessionId, async () => {
      if (!ticket.settled) {
        await store.recordUsage(
          ticket.goalId,
          outcome.usage ?? { usageComplete: false },
        );
        ticket.settled = true;
      }
      const current = store.getSnapshot();
      if (
        current?.goalId === ticket.goalId &&
        current.status === "complete" &&
        ![...(this.tickets.get(sessionId) ?? [])].some(
          (other) =>
            other !== ticket &&
            other.goalId === ticket.goalId &&
            !other.settled,
        )
      )
        await store.clearCompleted(ticket.goalId);
      this.tickets.get(sessionId)?.delete(ticket);
    });
  }

  ensureDriving(sessionId: string): void {
    if (this.runner === undefined) return;
    if (this.driving.has(sessionId)) return;
    const runner = this.runner;
    const epoch = this.currentExecutionEpoch(sessionId);
    const goalId = this.peekSnapshot(sessionId)?.goalId;
    if (goalId === undefined) return;
    this.requested.delete(sessionId);
    const loop = (async (): Promise<void> => {
      const store = await this.storeFor(sessionId);
      await driveGoal({
        pause: (reason, actor) =>
          this.pauseExecution(sessionId, goalId, epoch, reason, actor),
        runner,
        safetyCapTurns: this.safetyCapTurns,
        sessionId,
        store,
        goalId,
        executionEpoch: epoch,
        isCurrent: () => this.isExecutionCurrent(sessionId, goalId, epoch),
      });
    })()
      .catch(async (error: unknown) => {
        this.deps.onError?.({ error, sessionId });
        await this.pauseExecution(
          sessionId,
          goalId,
          epoch,
          `runtime error: ${errorMessage(error)}`,
          "runtime",
        ).catch(() => undefined);
      })
      .finally(() => {
        if (this.driving.get(sessionId) !== loop) return;
        this.driving.delete(sessionId);
        const changed =
          this.currentExecutionEpoch(sessionId) !== epoch ||
          this.peekSnapshot(sessionId)?.goalId !== goalId;
        const requested = this.requested.delete(sessionId);
        if (
          (changed || requested) &&
          this.peekSnapshot(sessionId)?.status === "active"
        )
          this.ensureDriving(sessionId);
      });
    this.driving.set(sessionId, loop);
  }

  /** Shutdown calls without a session after closing admission; join successor generations too. */
  async whenIdle(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      await this.driving.get(sessionId);
      return;
    }
    while (this.driving.size > 0) await Promise.all([...this.driving.values()]);
  }

  async createGoal(
    sessionId: string,
    input: CreateGoalInput,
    runId?: string,
  ): Promise<GoalSnapshot> {
    const observed = this.peekSnapshot(sessionId);
    const store = await this.storeFor(sessionId);
    const observedGoalId = (
      observed === undefined ? store.getSnapshot() : observed
    )?.goalId;
    const snapshot = await this.mutate(sessionId, async () => {
      if (input.actor === "model" || runId !== undefined)
        this.requireMutation(sessionId, runId, observedGoalId);
      const result = await store.create(input);
      this.invalidate(sessionId);
      return result;
    });
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async resumeGoal(sessionId: string): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const snapshot = await this.mutate(sessionId, async () => {
      const wasActive = store.getSnapshot()?.status === "active";
      const result = await store.resume("user");
      if (!wasActive) this.invalidate(sessionId);
      return result;
    });
    if (this.driving.has(sessionId)) this.requested.add(sessionId);
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async pauseGoal(
    sessionId: string,
    reason = "Paused by user",
  ): Promise<GoalSnapshot> {
    const snapshot = await this.pauseActiveGoal(sessionId, reason, "user");
    if (snapshot === null)
      throw new GoalError("no_goal", "No goal is currently set.");
    return snapshot;
  }

  async cancelGoal(sessionId: string): Promise<void> {
    const store = await this.storeFor(sessionId);
    const interrupt = await this.mutate(sessionId, async () => {
      const current = store.getSnapshot();
      const ticket = this.currentTicket(sessionId, current?.goalId);
      await store.cancel("user");
      if (current !== null) this.invalidate(sessionId);
      return current?.status === "active"
        ? this.interruptInput(sessionId, "goal cancelled", true, ticket)
        : undefined;
    });
    if (interrupt !== undefined)
      await this.deps.executionControl.interruptGoalExecution(interrupt);
  }

  async replaceGoal(
    sessionId: string,
    objective: string,
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const { snapshot, changed } = await this.mutate(sessionId, async () => {
      const before = store.getSnapshot();
      const snapshot = await store.replaceObjective(objective, "user");
      const changed = before?.objective !== snapshot.objective;
      if (changed) this.invalidate(sessionId);
      return { snapshot, changed };
    });
    if (changed) this.ensureDriving(sessionId);
    return snapshot;
  }

  async setBudget(
    sessionId: string,
    limits: GoalBudgetLimits,
    runId?: string,
  ): Promise<GoalSnapshot> {
    const observed = this.peekSnapshot(sessionId);
    const store = await this.storeFor(sessionId);
    const observedGoalId = (
      observed === undefined ? store.getSnapshot() : observed
    )?.goalId;
    return this.mutate(sessionId, async () => {
      this.requireMutation(sessionId, runId, observedGoalId);
      return store.setBudgetLimits(limits, "model");
    });
  }

  async getSnapshot(sessionId: string): Promise<GoalSnapshot | null> {
    const store = await this.storeFor(sessionId);
    return store.getSnapshot();
  }

  async updateGoalFromModel(
    sessionId: string,
    status: GoalStatus,
    reason?: string,
    runId?: string,
  ): Promise<{
    readonly snapshot: GoalSnapshot | null;
    readonly note: string;
  }> {
    const observed = this.peekSnapshot(sessionId);
    const store = await this.storeFor(sessionId);
    const observedGoalId = (
      observed === undefined ? store.getSnapshot() : observed
    )?.goalId;
    let interrupt: ReturnType<GoalService["interruptInput"]> | undefined;
    const result = await this.mutate(sessionId, async () => {
      this.requireMutation(sessionId, runId, observedGoalId);
      const current = store.getSnapshot();
      if (current?.status !== "active")
        return { note: inactiveGoalNote(current), snapshot: current };
      if (status === "active")
        return { note: "Goal is already active.", snapshot: current };
      const ticket = this.currentTicket(sessionId, current.goalId);
      if (status === "complete") {
        await store.markComplete("model");
        this.invalidate(sessionId);
        if (ticket === undefined) await store.clearCompleted(current.goalId);
        interrupt = this.interruptInput(
          sessionId,
          "goal completed",
          false,
          ticket,
        );
        return { note: "Goal completed.", snapshot: null };
      }
      const snapshot = await store.pause(reason ?? "Paused by model", "model");
      this.invalidate(sessionId);
      interrupt = this.interruptInput(
        sessionId,
        reason ?? "Paused by model",
        true,
        ticket,
      );
      return { note: `Goal paused: ${snapshot.pauseReason ?? ""}`, snapshot };
    });
    if (interrupt !== undefined)
      await this.deps.executionControl.interruptGoalExecution(interrupt);
    return result;
  }

  async pauseExecution(
    sessionId: string,
    goalId: string,
    epoch: number,
    reason: string,
    actor: GoalActor = "runtime",
  ): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(sessionId, reason, actor, { goalId, epoch });
  }

  private async pauseActiveGoal(
    sessionId: string,
    reason: string,
    actor: GoalActor,
    expected?: { goalId: string; epoch: number },
  ): Promise<GoalSnapshot | null> {
    const store = await this.storeFor(sessionId);
    let interrupt: ReturnType<GoalService["interruptInput"]> | undefined;
    const snapshot = await this.mutate(sessionId, async () => {
      if (
        expected !== undefined &&
        !this.isExecutionCurrent(sessionId, expected.goalId, expected.epoch)
      )
        return store.getSnapshot();
      const current = store.getSnapshot();
      const ticket = this.currentTicket(sessionId, current?.goalId);
      const result = await store.pause(reason, actor);
      if (current?.status === "active") {
        this.invalidate(sessionId);
        interrupt = this.interruptInput(sessionId, reason, true, ticket);
      }
      return result;
    });
    if (interrupt !== undefined)
      await this.deps.executionControl.interruptGoalExecution(interrupt);
    return snapshot;
  }

  private mutate<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    return this.deps.withSessionMutation?.(sessionId, op) ?? op();
  }

  private invalidate(sessionId: string): void {
    this.epochs.set(sessionId, this.currentExecutionEpoch(sessionId) + 1);
    for (const ticket of this.tickets.get(sessionId) ?? [])
      ticket.controller.abort();
  }

  private currentTicket(
    sessionId: string,
    goalId: string | undefined,
  ): GoalTurnTicket | undefined {
    return [...(this.tickets.get(sessionId) ?? [])].find(
      (ticket) => ticket.goalId === goalId,
    );
  }

  private interruptInput(
    sessionId: string,
    reason: string,
    includePrimary: boolean,
    ticket?: GoalTurnTicket,
  ): GoalExecutionInterruptInput {
    if (ticket !== undefined) ticket.stopIntent = { reason, includePrimary };
    return {
      sessionId,
      reason,
      includePrimary,
      ...(ticket === undefined ? {} : { ticket }),
      ...(ticket?.runId === undefined ? {} : { expectedRunId: ticket.runId }),
    };
  }

  private requireMutation(
    sessionId: string,
    runId?: string,
    observedGoalId?: string,
  ): void {
    if (runId === undefined) {
      if (this.deps.resolveMutationContext !== undefined)
        throw new GoalError(
          "invalid_transition",
          "Model goal changes require a trusted run identity.",
        );
      return;
    }
    const context = this.deps.resolveMutationContext?.(sessionId, runId) ?? {
      kind: "invalid",
    };
    if (
      context.kind === "user" &&
      this.peekSnapshot(sessionId)?.goalId === observedGoalId
    )
      return;
    if (
      context.kind === "goal" &&
      this.isExecutionCurrent(
        sessionId,
        context.ticket.goalId,
        context.ticket.executionEpoch,
      )
    )
      return;
    throw new GoalError(
      "invalid_transition",
      "This run no longer has permission to modify the current goal.",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function inactiveGoalNote(snapshot: GoalSnapshot | null): string {
  return snapshot === null
    ? "No goal is currently set."
    : snapshot.status === "complete"
      ? "Goal is complete."
      : `Goal is ${snapshot.status}. Ask the user to run /goal resume to continue it.`;
}
