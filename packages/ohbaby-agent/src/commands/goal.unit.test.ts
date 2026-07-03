import { describe, expect, it, vi } from "vitest";
import type { UiCommandInvocation, UiCommandOutput } from "ohbaby-sdk";
import { computeBudgetReport } from "../goals/index.js";
import type { GoalSnapshot } from "../goals/index.js";
import { createGoalCommandHandler } from "./goal.js";
import type { CommandGoalBackend, CommandRunContext } from "./types.js";

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  const usage = { tokensUsed: 0, turnsUsed: 0, wallClockMs: 0 };
  return {
    budget: computeBudgetReport(usage, {}),
    budgetLimits: {},
    goalId: "g1",
    objective: "fix tests",
    status: "active",
    tokensUsed: 0,
    turnsUsed: 0,
    wallClockMs: 0,
    ...overrides,
  };
}

function makeBackend(
  overrides: Partial<CommandGoalBackend> = {},
): CommandGoalBackend {
  return {
    cancel: vi.fn(() => Promise.resolve(undefined)),
    create: vi.fn(() => Promise.resolve(snapshot())),
    pause: vi.fn(() => Promise.resolve(snapshot({ status: "paused" }))),
    replace: vi.fn(() => Promise.resolve(snapshot({ objective: "new obj" }))),
    resolveSessionId: vi.fn(() => Promise.resolve<string | undefined>("s1")),
    resume: vi.fn(() => Promise.resolve(snapshot())),
    setBudget: vi.fn(() => Promise.resolve(snapshot())),
    status: vi.fn(() => Promise.resolve<GoalSnapshot | null>(snapshot())),
    ...overrides,
  };
}

function invoke(argv: readonly string[]): UiCommandInvocation {
  return {
    argv,
    clientInvocationId: "i1",
    commandId: "goal",
    path: ["goal"],
    raw: `/goal ${argv.join(" ")}`,
    rawArgs: argv.join(" "),
    surface: "tui",
  };
}

function makeContext(): {
  context: CommandRunContext;
  outputs: UiCommandOutput[];
  failures: unknown[];
} {
  const outputs: UiCommandOutput[] = [];
  const failures: unknown[] = [];
  return {
    context: {
      clientInvocationId: "i1",
      commandRunId: "r1",
      emitAction: () => undefined,
      emitOutput: (output): void => {
        outputs.push(output);
      },
      fail: (error): void => {
        failures.push(error);
      },
      requestInteraction: () => {
        throw new Error("not used");
      },
      surface: "tui",
    },
    failures,
    outputs,
  };
}

describe("/goal command handler", () => {
  it("bare /goal shows status", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, outputs } = makeContext();
    await handler.execute(invoke([]), context);
    expect(backend.status).toHaveBeenCalledWith("s1");
    expect(JSON.stringify(outputs)).toContain("fix tests");
  });

  it("free text creates a goal", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    const { context } = makeContext();
    await handler.execute(invoke(["fix", "all", "tests"]), context);
    expect(backend.create).toHaveBeenCalledWith("s1", {
      objective: "fix all tests",
    });
  });

  it("pause / resume / cancel / replace route to backend", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    await handler.execute(invoke(["pause"]), makeContext().context);
    await handler.execute(invoke(["resume"]), makeContext().context);
    await handler.execute(invoke(["cancel"]), makeContext().context);
    await handler.execute(
      invoke(["replace", "new", "obj"]),
      makeContext().context,
    );
    expect(backend.pause).toHaveBeenCalled();
    expect(backend.resume).toHaveBeenCalled();
    expect(backend.cancel).toHaveBeenCalled();
    expect(backend.replace).toHaveBeenCalledWith("s1", "new obj");
  });

  it("budget flags parse to limits (minutes → ms)", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    await handler.execute(
      invoke(["budget", "--turns", "20", "--minutes", "5"]),
      makeContext().context,
    );
    expect(backend.setBudget).toHaveBeenCalledWith("s1", {
      turnBudget: 20,
      wallClockBudgetMs: 300000,
    });
  });

  it("budget without flags fails with usage error", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, failures } = makeContext();
    await handler.execute(invoke(["budget"]), context);
    expect(failures).toHaveLength(1);
    expect(backend.setBudget).not.toHaveBeenCalled();
  });

  it("fails cleanly without a session", async () => {
    const backend = makeBackend({
      resolveSessionId: vi.fn(() =>
        Promise.resolve<string | undefined>(undefined),
      ),
    });
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, failures } = makeContext();
    await handler.execute(invoke(["status"]), context);
    expect(failures).toHaveLength(1);
  });

  it("fails cleanly when backend missing", async () => {
    const handler = createGoalCommandHandler({});
    const { context, failures } = makeContext();
    await handler.execute(invoke([]), context);
    expect(failures).toHaveLength(1);
  });
});
