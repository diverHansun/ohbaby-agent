import { describe, expect, it, vi } from "vitest";
import type { UiCommandInvocation, UiCommandOutput } from "ohbaby-sdk";
import { computeBudgetReport, planResume } from "../goals/budget.js";
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
      requestInteraction: (): never => {
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

  it("rejects the removed budget subcommand and points to natural language", async () => {
    const backend = makeBackend();
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, failures } = makeContext();

    await handler.execute(invoke(["budget", "--turns", "20"]), context);

    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).toContain("natural language");
  });

  it("shows an empty status without a session", async () => {
    const backend = makeBackend({
      resolveSessionId: vi.fn(() =>
        Promise.resolve<string | undefined>(undefined),
      ),
    });
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, failures, outputs } = makeContext();
    await handler.execute(invoke(["status"]), context);
    expect(failures).toHaveLength(0);
    expect(backend.status).not.toHaveBeenCalled();
    expect(outputs).toEqual([
      {
        kind: "text",
        text: "No goal is currently set.",
      },
    ]);
  });

  it("fails cleanly without a session for mutating commands", async () => {
    const backend = makeBackend({
      resolveSessionId: vi.fn(() =>
        Promise.resolve<string | undefined>(undefined),
      ),
    });
    const handler = createGoalCommandHandler({ goals: backend });
    const { context, failures } = makeContext();
    await handler.execute(invoke(["pause"]), context);
    expect(failures).toHaveLength(1);
    expect(backend.pause).not.toHaveBeenCalled();
  });

  it("fails cleanly when backend missing", async () => {
    const handler = createGoalCommandHandler({});
    const { context, failures } = makeContext();
    await handler.execute(invoke([]), context);
    expect(failures).toHaveLength(1);
  });
});

describe("/goal resume limits", () => {
  it.each([
    [[], {}],
    [["100", "turns"], { turnBudget: 100 }],
    [["3h"], { wallClockBudgetMs: 10_800_000 }],
    [
      ["100", "turns", "3h"],
      { turnBudget: 100, wallClockBudgetMs: 10_800_000 },
    ],
    [
      ["3h", "100", "turns"],
      { turnBudget: 100, wallClockBudgetMs: 10_800_000 },
    ],
  ])(
    "applies %j as total limits and emits the resulting status",
    async (args, expected) => {
      let state = snapshot({ status: "paused", turnsUsed: 2 });
      const backend = makeBackend({
        resume: (_sessionId, limits) => {
          const merged = planResume(state, limits);
          state = {
            ...state,
            budgetLimits: merged,
            status: "active",
            budget: computeBudgetReport(state, merged),
          };
          return Promise.resolve(state);
        },
      });
      const { context, outputs, failures } = makeContext();
      await createGoalCommandHandler({ goals: backend }).execute(
        invoke(["resume", ...(args as string[])]),
        context,
      );
      expect(failures).toEqual([]);
      expect(state.status).toBe("active");
      expect(state.turnsUsed).toBe(2);
      expect(state.budgetLimits).toEqual(expected);
      expect(JSON.stringify(outputs)).toContain("active");
    },
  );

  it.each([
    "100 turns extra",
    "20 turns 30 turns",
    "3h 4h",
    "tokens",
    "1.5 turns",
    "25h",
  ])("rejects %j before changing the goal", async (args) => {
    let state = snapshot({ status: "paused" });
    const backend = makeBackend({
      resume: () => {
        state = { ...state, status: "active" };
        return Promise.resolve(state);
      },
    });
    const { context, outputs, failures } = makeContext();
    await createGoalCommandHandler({ goals: backend }).execute(
      invoke(["resume", ...args.split(" ")]),
      context,
    );
    expect(state.status).toBe("paused");
    expect(outputs).toEqual([]);
    expect(failures).toEqual([
      expect.objectContaining({ code: "invalid_budget" }),
    ]);
  });

  it("preserves actionable budget errors from the backend", async () => {
    const state = snapshot({
      status: "paused",
      turnsUsed: 20,
      wallClockMs: 3_600_000,
      budgetLimits: { turnBudget: 20, wallClockBudgetMs: 3_600_000 },
    });
    const backend = makeBackend({
      resume: (_id, limits) => {
        planResume(state, limits);
        return Promise.resolve(state);
      },
    });
    const { context, failures } = makeContext();
    await createGoalCommandHandler({ goals: backend }).execute(
      invoke(["resume", "40", "turns"]),
      context,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "budget_reached" });
    expect(JSON.stringify(failures[0])).toContain(
      "active time used 3600000/3600000",
    );
  });
});
