import { describe, expect, it, vi } from "vitest";
import type { UiCommandInvocation, UiCommandOutput } from "ohbaby-sdk";
import { parseSlashCommandInput, resolveSlashCommand } from "ohbaby-sdk";
import { computeBudgetReport, planResume } from "../goals/budget.js";
import type { GoalSnapshot } from "../goals/index.js";
import { InMemoryGoalPersistence } from "../goals/persistence.js";
import { GoalService } from "../goals/service.js";
import { buildCommandCatalog } from "./catalog.js";
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

function parsedInvocation(raw: string): UiCommandInvocation {
  const resolved = resolveSlashCommand(
    buildCommandCatalog(),
    parseSlashCommandInput(raw),
    { surface: "tui" },
  );
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    argv: resolved.argv,
    body: resolved.body,
    clientInvocationId: "i1",
    commandId: resolved.command.id,
    path: resolved.path,
    raw: resolved.raw,
    rawArgs: resolved.rawArgs,
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

  it.each([
    {
      action: "create",
      raw: '/goal "检查  台北" 天气\n\n  汇总 <>& 并注明来源\n结束  ',
      objective: "检查  台北 天气\n\n  汇总 <>& 并注明来源\n结束",
    },
    {
      action: "replace",
      raw: '/goal replace "检查  東京" 天气\r\n\r\n  汇总 <>& 并注明来源\r\n结束  ',
      objective: "检查  東京 天气\n\n  汇总 <>& 并注明来源\n结束",
    },
  ])(
    "preserves the parsed multiline objective on $action",
    async ({ action, raw, objective }) => {
      const service = new GoalService({
        persistence: new InMemoryGoalPersistence(),
        executionControl: {
          interruptGoalExecution: (): Promise<void> => Promise.resolve(),
        },
      });
      if (action === "replace") {
        await service.createGoal("s1", {
          objective: "old goal",
          actor: "user",
        });
      }
      const backend = makeBackend({
        create: (sessionId, input) =>
          service.createGoal(sessionId, { ...input, actor: "user" }),
        replace: (sessionId, nextObjective) =>
          service.replaceGoal(sessionId, nextObjective),
      });
      const { context, failures } = makeContext();

      await createGoalCommandHandler({ goals: backend }).execute(
        parsedInvocation(raw),
        context,
      );

      expect(failures).toEqual([]);
      expect(service.peekSnapshot("s1")?.objective).toBe(objective);
      service.dispose();
    },
  );

  it("keeps a body-only /goal request as a status command", async () => {
    const backend = makeBackend();
    const { context, outputs, failures } = makeContext();

    await createGoalCommandHandler({ goals: backend }).execute(
      parsedInvocation("/goal\nbody without a first-line objective"),
      context,
    );

    expect(failures).toEqual([]);
    expect(JSON.stringify(outputs)).toContain("fix tests");
    expect(backend.create).not.toHaveBeenCalled();
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
    "/goal resume 100 turns\n3h",
    "/goal resume\n3h 100 turns",
    "/goal resume 3h\r\n100 turns",
  ])("applies both limits from the complete parsed command %j", async (raw) => {
    const persistence = new InMemoryGoalPersistence();
    const service = new GoalService({
      persistence,
      executionControl: {
        interruptGoalExecution: (): Promise<void> => Promise.resolve(),
      },
    });
    try {
      await service.createGoal("s1", {
        actor: "user",
        objective: "Finish acceptance",
      });
      await service.pauseGoal("s1");
      const backend = makeBackend({
        resume: (sessionId, limits) => service.resumeGoal(sessionId, limits),
      });
      const { context, failures } = makeContext();
      await createGoalCommandHandler({ goals: backend }).execute(
        parsedInvocation(raw),
        context,
      );
      expect(failures).toEqual([]);
      expect(await service.getSnapshot("s1")).toMatchObject({
        status: "active",
        budgetLimits: { turnBudget: 100, wallClockBudgetMs: 10_800_000 },
      });
    } finally {
      service.dispose();
    }
  });

  it.each([
    "/goal resume 100 turns\nextra",
    "/goal resume 100 turns\n25h",
    "/goal resume 100 turns\n30 turns",
    "/goal resume\n3h extra",
  ])(
    "rejects invalid multiline limits without persistence changes: %j",
    async (raw) => {
      const persistence = new InMemoryGoalPersistence();
      const service = new GoalService({
        persistence,
        executionControl: {
          interruptGoalExecution: (): Promise<void> => Promise.resolve(),
        },
      });
      try {
        await service.createGoal("s1", {
          actor: "user",
          objective: "Finish acceptance",
        });
        await service.pauseGoal("s1");
        const before = await persistence.list("s1");
        const backend = makeBackend({
          resume: (sessionId, limits) => service.resumeGoal(sessionId, limits),
        });
        const { context, failures, outputs } = makeContext();
        await createGoalCommandHandler({ goals: backend }).execute(
          parsedInvocation(raw),
          context,
        );
        expect(failures).toEqual([
          expect.objectContaining({ code: "invalid_budget" }),
        ]);
        expect(outputs).toEqual([]);
        expect(await persistence.list("s1")).toEqual(before);
      } finally {
        service.dispose();
      }
    },
  );

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
