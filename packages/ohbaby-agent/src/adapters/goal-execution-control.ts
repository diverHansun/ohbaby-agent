import type { GoalExecutionInterruptInput } from "../goals/index.js";

export interface GoalExecutionInterruptDeps {
  readonly activeRunId: () => string | undefined;
  readonly promptOwner: () => "goal" | "user" | undefined;
  readonly promptSessionId: () => string | undefined;
  abortPromptRun(runId: string): Promise<boolean>;
  interruptSubagentsByParent(
    sessionId: string,
    reason: string,
  ): Promise<void>;
  waitForPromptRunReadyOrIdle(): Promise<void>;
}

/** Owner-aware adapter boundary shared by active-primary and only-background windows. */
export async function executeGoalExecutionInterrupt(
  input: GoalExecutionInterruptInput,
  deps: GoalExecutionInterruptDeps,
): Promise<void> {
  let interruptedWithPrimary = false;
  if (
    input.includePrimary &&
    deps.promptOwner() === "goal" &&
    deps.promptSessionId() === input.sessionId
  ) {
    await deps.waitForPromptRunReadyOrIdle();
    const runId = deps.activeRunId();
    if (runId !== undefined) {
      interruptedWithPrimary = await deps.abortPromptRun(runId);
    }
  }
  if (!interruptedWithPrimary) {
    await deps.interruptSubagentsByParent(input.sessionId, input.reason);
  }
}
