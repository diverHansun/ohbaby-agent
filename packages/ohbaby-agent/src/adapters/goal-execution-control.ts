import type { GoalExecutionInterruptInput } from "../goals/index.js";

export interface GoalExecutionInterruptDeps {
  readonly activeRunId: () => string | undefined;
  readonly promptOwner: () => "goal" | "user" | "subagent" | undefined;
  readonly promptSessionId: () => string | undefined;
  abortPromptRun(runId: string): Promise<boolean>;
  interruptSubagentsByRootRun(runId: string, reason: string): Promise<void>;
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
    const expectedRunId = input.expectedRunId ?? input.ticket?.runId;
    if (
      runId !== undefined &&
      runId === expectedRunId &&
      deps.promptOwner() === "goal" &&
      deps.promptSessionId() === input.sessionId
    ) {
      interruptedWithPrimary = await deps.abortPromptRun(runId);
    }
  }
  if (input.preserveBackground) return;
  if (input.rootRunIds !== undefined) {
    for (const runId of new Set(input.rootRunIds)) {
      await deps.interruptSubagentsByRootRun(runId, input.reason);
    }
    return;
  }
  const rootRunId = input.expectedRunId ?? input.ticket?.runId;
  if (!interruptedWithPrimary && rootRunId !== undefined) {
    await deps.interruptSubagentsByRootRun(rootRunId, input.reason);
  }
}
