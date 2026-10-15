import { isSafetyCapReached } from "./budget.js";
import type { GoalStore } from "./store.js";
import type { GoalActor, GoalTurnRunner } from "./types.js";

export interface DriveGoalDeps {
  readonly store: GoalStore;
  readonly runner: GoalTurnRunner;
  readonly sessionId: string;
  readonly safetyCapTurns: number;
  readonly goalId?: string;
  readonly executionEpoch?: number;
  readonly isCurrent?: () => boolean;
  readonly pause: (reason: string, actor: GoalActor) => Promise<unknown>;
}

/** Driver owns iteration; adapter owns admission and the execution lease. */
export async function driveGoal(deps: DriveGoalDeps): Promise<void> {
  const { pause, runner, safetyCapTurns, sessionId, store } = deps;
  const goalId = deps.goalId ?? store.getSnapshot()?.goalId;
  const epoch = deps.executionEpoch ?? 0;
  for (;;) {
    const snapshot = store.getSnapshot();
    if (
      snapshot?.status !== "active" ||
      snapshot.goalId !== goalId ||
      deps.isCurrent?.() === false
    )
      return;
    if (
      snapshot.budget.overBudget ||
      isSafetyCapReached(snapshot, safetyCapTurns)
    ) {
      await pause(
        snapshot.budget.overBudget
          ? "A configured budget was reached"
          : "Safety cap reached: too many continuation turns without completion",
        "runtime",
      );
      return;
    }
    const outcome = await runner.runTurn(sessionId, snapshot.goalId, epoch);
    // The adapter waits internally while admission is possible. A refusal ends
    // this generation, including shutdown with a still-active persisted goal.
    if (outcome.status === "not_admitted" || outcome.ticket?.recoveryPending)
      return;
    try {
      const ticket = outcome.ticket;
      if (ticket !== undefined) {
        if (runner.finishTurn === undefined)
          throw new Error(
            "Goal runner must settle admitted turns before releasing execution.",
          );
        await runner.finishTurn(sessionId, ticket, outcome);
      }
      if (
        deps.isCurrent?.() === false ||
        store.getSnapshot()?.goalId !== goalId
      )
        return;
      if (outcome.status === "cancelled") {
        await pause("interrupted", "user");
        return;
      }
      if (outcome.status === "failed") {
        await pause(`runtime error: ${outcome.error ?? "unknown"}`, "runtime");
        return;
      }
    } finally {
      outcome.release?.();
    }
  }
}
