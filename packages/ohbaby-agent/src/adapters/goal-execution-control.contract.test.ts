import { describe, expect, it, vi } from "vitest";
import { executeGoalExecutionInterrupt } from "./goal-execution-control.js";

describe("goal execution control adapter contract", () => {
  it("T-8 interrupts only-background work when there is no primary run", async () => {
    const abortPromptRun = vi.fn(() => Promise.resolve(false));
    const interruptSubagentsByParent = vi.fn(() => Promise.resolve());

    await executeGoalExecutionInterrupt(
      {
        includePrimary: true,
        reason: "safety pause",
        sessionId: "session_goal",
      },
      {
        abortPromptRun,
        activeRunId: () => undefined,
        interruptSubagentsByParent,
        promptOwner: () => undefined,
        promptSessionId: () => undefined,
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
      },
    );

    expect(abortPromptRun).not.toHaveBeenCalled();
    expect(interruptSubagentsByParent).toHaveBeenCalledOnce();
    expect(interruptSubagentsByParent).toHaveBeenCalledWith(
      "session_goal",
      "safety pause",
    );
  });

  it("does not issue a second parent interrupt after the primary run tree aborts", async () => {
    const abortPromptRun = vi.fn(() => Promise.resolve(true));
    const interruptSubagentsByParent = vi.fn(() => Promise.resolve());

    await executeGoalExecutionInterrupt(
      {
        includePrimary: true,
        reason: "user pause",
        sessionId: "session_goal",
      },
      {
        abortPromptRun,
        activeRunId: () => "run_goal",
        interruptSubagentsByParent,
        promptOwner: () => "goal",
        promptSessionId: () => "session_goal",
        waitForPromptRunReadyOrIdle: () => Promise.resolve(),
      },
    );

    expect(abortPromptRun).toHaveBeenCalledWith("run_goal");
    expect(interruptSubagentsByParent).not.toHaveBeenCalled();
  });
});
