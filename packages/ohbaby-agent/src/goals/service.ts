import { validateGoalBudgetLimits } from "./budget-input.js";
import { BlockedAudit } from "./blocked-audit.js";
import { planResume } from "./budget.js";
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
  private readonly ownedRuns = new Map<string, Set<string>>();
  private readonly interrupting = new Map<string, Set<Promise<void>>>();
  private readonly requested = new Set<string>();
  private readonly audits = new Map<string, BlockedAudit>();
  private readonly deadlines = new Map<
    string,
    { token: symbol; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;
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
    const roots = this.ownedRuns.get(ticket.goalId) ?? new Set<string>();
    roots.add(runId);
    this.ownedRuns.set(ticket.goalId, roots);
  }

  getOwnedRunIds(goalId: string): readonly string[] {
    return [...(this.ownedRuns.get(goalId) ?? [])];
  }

  isAutomaticRunBudgetExhausted(sessionId: string): boolean {
    const snapshot = this.peekSnapshot(sessionId);
    return (
      snapshot !== undefined &&
      snapshot !== null &&
      this.budgetExhausted(snapshot)
    );
  }

  /** An input arriving while a previous driver settles still requests its successor. */
  notifyWorkAvailable(sessionId: string): void {
    if (this.peekSnapshot(sessionId)?.status !== "active") return;
    if (this.driving.has(sessionId)) this.requested.add(sessionId);
    this.ensureDriving(sessionId);
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
    if (this.budgetExhausted(before)) {
      const reason = before.budget.overBudget
        ? "A configured budget was reached"
        : "Safety cap reached: too many continuation turns without completion";
      const ticket = this.currentTicket(sessionId, goalId);
      await store.block(reason, "runtime");
      this.invalidate(sessionId);
      if (this.hasOwnedExecution(goalId, ticket)) {
        // The caller owns the session lock: begin cleanup without joining it here.
        this.deferInterrupt(
          this.interruptInput({
            sessionId,
            reason,
            includePrimary: true,
            ticket,
            goalId,
          }),
        );
      }
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
          ? snapshot.objective
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
    if (this.disposed || this.runner === undefined) return;
    if (this.driving.has(sessionId)) return;
    const runner = this.runner;
    const epoch = this.currentExecutionEpoch(sessionId);
    const goalId = this.peekSnapshot(sessionId)?.goalId;
    if (goalId === undefined) return;
    this.requested.delete(sessionId);
    const loop = (async (): Promise<void> => {
      const store = await this.storeFor(sessionId);
      await driveGoal({
        block: (reason, actor) =>
          this.blockExecution(sessionId, goalId, epoch, reason, actor),
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
    for (;;) {
      const work =
        sessionId === undefined
          ? [
              ...this.driving.values(),
              ...[...this.interrupting.values()].flatMap((entries) => [
                ...entries,
              ]),
            ]
          : [
              this.driving.get(sessionId),
              ...(this.interrupting.get(sessionId) ?? []),
            ].filter((entry): entry is Promise<void> => entry !== undefined);
      if (work.length === 0) return;
      await Promise.all(work);
    }
  }

  private deferInterrupt(input: GoalExecutionInterruptInput): void {
    const entries =
      this.interrupting.get(input.sessionId) ?? new Set<Promise<void>>();
    this.interrupting.set(input.sessionId, entries);
    const pending = Promise.resolve()
      .then(() => this.deps.executionControl.interruptGoalExecution(input))
      .catch((error: unknown) =>
        this.deps.onError?.({ error, sessionId: input.sessionId }),
      )
      .finally(() => {
        entries.delete(pending);
        if (entries.size === 0) this.interrupting.delete(input.sessionId);
      });
    entries.add(pending);
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
    const { snapshot, interrupt } = await this.mutate(sessionId, async () => {
      if (input.actor === "model" || runId !== undefined)
        this.requireMutation(sessionId, runId, observedGoalId);
      const previous = store.getSnapshot();
      const ticket = this.currentTicket(sessionId, previous?.goalId);
      const result = await store.create(input);
      this.invalidate(sessionId);
      this.audits.delete(sessionId);
      return {
        snapshot: result,
        interrupt:
          previous !== null && this.hasOwnedExecution(previous.goalId, ticket)
            ? this.interruptInput({
                sessionId,
                reason: "goal replaced",
                includePrimary: false,
                ticket,
                goalId: previous.goalId,
              })
            : undefined,
      };
    });
    if (interrupt !== undefined) {
      await this.deps.executionControl.interruptGoalExecution(interrupt);
      if (interrupt.goalId) this.ownedRuns.delete(interrupt.goalId);
    }
    this.armDeadline(sessionId);
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async resumeGoal(
    sessionId: string,
    limits: GoalBudgetLimits = {},
  ): Promise<GoalSnapshot> {
    const store = await this.storeFor(sessionId);
    const snapshot = await this.mutate(sessionId, async () => {
      const current = store.getSnapshot();
      if (current === null)
        throw new GoalError("no_goal", "No goal is currently set.");
      const merged = planResume(current, limits, this.safetyCapTurns);
      const result = await store.resumeWithBudget(merged, "user");
      if (current.status !== "active") {
        this.invalidate(sessionId);
        this.audits.delete(sessionId);
      }
      return result;
    });
    this.armDeadline(sessionId);
    if (this.driving.has(sessionId)) this.requested.add(sessionId);
    this.ensureDriving(sessionId);
    return snapshot;
  }

  async pauseGoal(
    sessionId: string,
    reason = "Paused by user",
  ): Promise<GoalSnapshot> {
    const snapshot = await this.pauseActiveGoal({
      sessionId,
      reason,
      actor: "user",
    });
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
      return current &&
        (current.status === "active" ||
          this.getOwnedRunIds(current.goalId).length > 0)
        ? this.interruptInput({
            sessionId,
            reason: "goal cancelled",
            includePrimary: true,
            ticket,
            goalId: current.goalId,
          })
        : undefined;
    });
    if (interrupt !== undefined) {
      await this.deps.executionControl.interruptGoalExecution(interrupt);
      if (interrupt.goalId) this.ownedRuns.delete(interrupt.goalId);
    }
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
      if (changed) {
        this.invalidate(sessionId);
        this.audits.delete(sessionId);
      }
      return { snapshot, changed };
    });
    if (changed) {
      this.armDeadline(sessionId);
      this.ensureDriving(sessionId);
    }
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
    const snapshot = await this.mutate(sessionId, async () => {
      this.requireMutation(sessionId, runId, observedGoalId);
      return store.setBudgetLimits(validateGoalBudgetLimits(limits), "model");
    });
    this.armDeadline(sessionId);
    return snapshot;
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
    if (status !== "complete" && status !== "blocked")
      throw new GoalError(
        "invalid_transition",
        "Models may only report complete or blocked.",
      );
    if (status === "blocked" && !reason?.trim())
      throw new GoalError(
        "invalid_transition",
        "A blocked report requires a non-empty reason.",
      );
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
      const ticket = this.currentTicket(sessionId, current.goalId);
      if (status === "complete") {
        await store.markComplete("model");
        this.invalidate(sessionId);
        if (ticket === undefined) await store.clearCompleted(current.goalId);
        interrupt = this.interruptInput({
          sessionId,
          reason: "goal completed",
          includePrimary: false,
          ticket,
          goalId: current.goalId,
        });
        return { note: "Goal completed.", snapshot: null };
      }
      const reportingTicket =
        runId === undefined
          ? undefined
          : this.getTicketForRun(sessionId, runId);
      if (
        runId === undefined ||
        reportingTicket === undefined ||
        !this.isExecutionCurrent(
          sessionId,
          reportingTicket.goalId,
          reportingTicket.executionEpoch,
        )
      )
        return {
          note: "Blocker not counted: only an admitted current goal run can report a blocker.",
          snapshot: current,
        };
      const audit = this.audits.get(sessionId) ?? new BlockedAudit();
      this.audits.set(sessionId, audit);
      const blocker = (reason ?? "").trim();
      const count = await audit.report(
        runId,
        reportingTicket.turnNumber,
        blocker,
        async () => {
          await store.block(blocker, "model");
          this.invalidate(sessionId);
          interrupt = this.interruptInput({
            sessionId,
            reason: blocker,
            includePrimary: false,
            ticket: reportingTicket,
          });
        },
      );
      return {
        note:
          count >= 3
            ? `Goal blocked: ${blocker}. Use /goal resume to continue.`
            : `Blocker recorded (${String(count)}/3 consecutive goal turns). The goal is still active.`,
        snapshot: store.getSnapshot(),
      };
    });
    if (interrupt !== undefined) {
      await this.deps.executionControl.interruptGoalExecution(interrupt);
      if (status === "complete" && interrupt.goalId)
        this.ownedRuns.delete(interrupt.goalId);
    }
    return result;
  }

  async pauseExecution(
    sessionId: string,
    goalId: string,
    epoch: number,
    reason: string,
    actor: GoalActor = "runtime",
  ): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal({
      sessionId,
      reason,
      actor,
      expected: { goalId, epoch },
      preserveBackground: actor === "user",
    });
  }

  private async pauseActiveGoal({
    sessionId,
    reason,
    actor,
    expected,
    preserveBackground = false,
  }: {
    readonly sessionId: string;
    readonly reason: string;
    readonly actor: GoalActor;
    readonly expected?: { readonly goalId: string; readonly epoch: number };
    readonly preserveBackground?: boolean;
  }): Promise<GoalSnapshot | null> {
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
        interrupt = this.interruptInput({
          sessionId,
          reason,
          includePrimary: true,
          ticket,
          goalId: current.goalId,
          preserveBackground,
        });
      }
      return result;
    });
    if (interrupt !== undefined)
      await this.deps.executionControl.interruptGoalExecution(interrupt);
    return snapshot;
  }

  private async blockExecution(
    sessionId: string,
    goalId: string,
    epoch: number,
    reason: string,
    actor: GoalActor = "runtime",
  ): Promise<void> {
    const store = await this.storeFor(sessionId);
    const interrupt = await this.mutate(sessionId, async () => {
      if (!this.isExecutionCurrent(sessionId, goalId, epoch)) return;
      const ticket = this.currentTicket(sessionId, goalId);
      await store.block(reason, actor);
      this.invalidate(sessionId);
      return !this.hasOwnedExecution(goalId, ticket)
        ? undefined
        : this.interruptInput({
            sessionId,
            reason,
            includePrimary: true,
            ticket,
            goalId,
          });
    });
    if (interrupt)
      await this.deps.executionControl.interruptGoalExecution(interrupt);
  }

  /** Stop local timers before the adapter releases sessions or closes admission. */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.deadlines.keys())
      this.clearDeadline(sessionId);
    this.audits.clear();
    this.requested.clear();
    this.ownedRuns.clear();
  }

  private clearDeadline(sessionId: string): void {
    const entry = this.deadlines.get(sessionId);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.deadlines.delete(sessionId);
  }

  private armDeadline(sessionId: string): void {
    this.clearDeadline(sessionId);
    const snapshot = this.peekSnapshot(sessionId);
    const remaining = snapshot?.budget.remainingWallClockMs;
    if (
      this.disposed ||
      snapshot?.status !== "active" ||
      remaining === undefined ||
      remaining === null
    )
      return;
    const token = Symbol("goal-deadline");
    const timer = setTimeout(
      () => {
        void this.onDeadline(sessionId, snapshot.goalId, token).catch(
          (error: unknown) => this.deps.onError?.({ sessionId, error }),
        );
      },
      Math.max(0, remaining),
    );
    timer.unref();
    this.deadlines.set(sessionId, { token, timer });
  }

  private async onDeadline(
    sessionId: string,
    goalId: string,
    token: symbol,
  ): Promise<void> {
    const action = await this.mutate(sessionId, async () => {
      if (this.disposed || this.deadlines.get(sessionId)?.token !== token)
        return;
      this.clearDeadline(sessionId);
      const store = this.initializedStores.get(sessionId);
      const snapshot = store?.getSnapshot();
      if (
        store === undefined ||
        snapshot?.goalId !== goalId ||
        snapshot.status !== "active"
      )
        return;
      if (!snapshot.budget.wallClockBudgetReached) {
        return "rearm" as const;
      }
      // Cancellation follows the actual admitted root, even if objective edits made its tools stale.
      const ticket = this.currentTicket(sessionId, goalId);
      const reason = "Active time budget reached";
      try {
        await store.block(reason, "runtime");
      } catch (error) {
        // Failed persistence must not let the captured execution run past its limit.
        // Keep the epoch unchanged: the existing cancelled outcome owns pausing,
        // and a changed epoch here could restart an active driver after failure.
        const interrupt = !this.hasOwnedExecution(goalId, ticket)
          ? undefined
          : this.interruptInput({
              sessionId,
              reason,
              includePrimary: true,
              ticket,
              goalId,
            });
        ticket?.controller.abort();
        return { error, interrupt };
      }
      this.invalidate(sessionId);
      return !this.hasOwnedExecution(goalId, ticket)
        ? undefined
        : this.interruptInput({
            sessionId,
            reason,
            includePrimary: true,
            ticket,
            goalId,
          });
    });
    if (action === "rearm") this.armDeadline(sessionId);
    else if (action !== undefined && "error" in action) {
      if (action.interrupt !== undefined) {
        try {
          await this.deps.executionControl.interruptGoalExecution(
            action.interrupt,
          );
        } catch (error) {
          this.deps.onError?.({ sessionId, error });
        }
      }
      throw action.error;
    } else if (action !== undefined)
      await this.deps.executionControl.interruptGoalExecution(action);
  }

  private mutate<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    return this.deps.withSessionMutation?.(sessionId, op) ?? op();
  }

  private invalidate(sessionId: string): void {
    this.clearDeadline(sessionId);
    this.epochs.set(sessionId, this.currentExecutionEpoch(sessionId) + 1);
    for (const ticket of this.tickets.get(sessionId) ?? [])
      ticket.controller.abort();
  }

  private budgetExhausted(snapshot: GoalSnapshot): boolean {
    return (
      snapshot.budget.overBudget || snapshot.turnsUsed >= this.safetyCapTurns
    );
  }

  private hasOwnedExecution(
    goalId: string,
    ticket: GoalTurnTicket | undefined,
  ): boolean {
    return ticket !== undefined || (this.ownedRuns.get(goalId)?.size ?? 0) > 0;
  }

  private currentTicket(
    sessionId: string,
    goalId: string | undefined,
  ): GoalTurnTicket | undefined {
    return [...(this.tickets.get(sessionId) ?? [])].find(
      (ticket) => ticket.goalId === goalId,
    );
  }

  private interruptInput({
    sessionId,
    reason,
    includePrimary,
    ticket,
    goalId = ticket?.goalId ?? this.peekSnapshot(sessionId)?.goalId,
    preserveBackground = false,
  }: {
    readonly sessionId: string;
    readonly reason: string;
    readonly includePrimary: boolean;
    readonly ticket?: GoalTurnTicket;
    readonly goalId?: string;
    readonly preserveBackground?: boolean;
  }): GoalExecutionInterruptInput {
    if (ticket !== undefined) ticket.stopIntent = { reason, includePrimary };
    const rootRunIds = goalId === undefined ? [] : this.getOwnedRunIds(goalId);
    return {
      sessionId,
      reason,
      includePrimary,
      ...(goalId === undefined ? {} : { goalId }),
      ...(rootRunIds.length === 0 ? {} : { rootRunIds }),
      ...(preserveBackground ? { preserveBackground: true } : {}),
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
