import { isSafetyCapReached } from "./budget.js";
import { renderGoalTurnPrompt } from "./injection.js";
import type { GoalStore } from "./store.js";
import type { GoalTurnRunner } from "./types.js";

export interface DriveGoalDeps {
  readonly store: GoalStore;
  readonly runner: GoalTurnRunner;
  readonly sessionId: string;
  readonly safetyCapTurns: number;
}

/**
 * 长任务续跑循环：只在 goal `active` 时推进。
 * 每轮：预算/安全阀判定 → incrementTurn → 渲染提醒作为 user 消息起一轮 Run →
 * 把 RunCompletion 翻译成状态迁移。模型经 UpdateGoal 自审终止；
 * cancelled/failed/预算/安全阀都 pause（恢复只有 /goal resume 一条路，不自动重入）。
 */
export async function driveGoal(deps: DriveGoalDeps): Promise<void> {
  const { runner, safetyCapTurns, sessionId, store } = deps;
  for (;;) {
    const snapshot = store.getSnapshot();
    if (snapshot?.status !== "active") return;
    if (snapshot.budget.overBudget) {
      await store.pause("A configured budget was reached", "runtime");
      return;
    }
    if (isSafetyCapReached(snapshot, snapshot.budgetLimits, safetyCapTurns)) {
      await store.pause(
        "Safety cap reached: too many continuation turns without completion",
        "runtime",
      );
      return;
    }
    await store.incrementTurn();
    const current = store.getSnapshot();
    if (current?.status !== "active") return;
    const prompt = renderGoalTurnPrompt(current, {
      isFirstTurn: current.turnsUsed === 1,
    });
    const outcome = await runner.runTurn(sessionId, prompt);
    if (outcome.tokensUsed !== undefined && outcome.tokensUsed > 0) {
      await store.recordTokenUsage(outcome.tokensUsed);
    }
    if (outcome.status === "cancelled") {
      if (store.getSnapshot()?.status === "active") {
        await store.pause("interrupted", "user");
      }
      return;
    }
    if (outcome.status === "failed") {
      if (store.getSnapshot()?.status === "active") {
        await store.pause(
          `runtime error: ${outcome.error ?? "unknown"}`,
          "runtime",
        );
      }
      return;
    }
    // succeeded → 回到循环顶部；模型若已 UpdateGoal(complete/paused)，读态即退出。
  }
}
