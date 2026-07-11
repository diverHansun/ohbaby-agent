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
