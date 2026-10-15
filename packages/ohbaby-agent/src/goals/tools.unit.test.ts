import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { GOAL_CONTINUATION_CORE } from "./constants.js";
import { PRIMARY_BASE_PROMPT_TEMPLATE } from "../core/system-prompt/prompts/templates.generated.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalService } from "./service.js";
import type { GoalMutationContext } from "./types.js";
import { createGoalTools } from "./tools.js";

function getTool(
  byName: Map<string, ReturnType<typeof createGoalTools>[number]>,
  name: string,
): ReturnType<typeof createGoalTools>[number] {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function ctx(sessionId = "s1"): ToolExecutionContext {
  return {
    callId: "c1",
    messageId: "m1",
    sessionId,
    signal: new AbortController().signal,
  };
}

function makeTools(): {
  byName: Map<string, ReturnType<typeof createGoalTools>[number]>;
  service: GoalService;
} {
  const service = new GoalService({
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
    persistence: new InMemoryGoalPersistence(),
  });
  const tools = createGoalTools(service);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { byName, service };
}

describe("goal tools", () => {
  it("exposes exactly four tools with schemas", () => {
    const { byName } = makeTools();
    expect([...byName.keys()].sort()).toEqual([
      "CreateGoal",
      "GetGoal",
      "SetGoalBudget",
      "UpdateGoal",
    ]);
    for (const tool of byName.values()) {
      expect(tool.parametersJsonSchema).toBeTypeOf("object");
      expect(tool.parametersJsonSchema).toMatchObject({
        additionalProperties: false,
      });
      expect(tool.parametersJsonSchema.properties).not.toHaveProperty("runId");
      expect(tool.source).toBe("builtin");
    }
  });

  it("CreateGoal creates for ctx.sessionId and GetGoal reads it back", async () => {
    const { byName } = makeTools();
    const created = await getTool(byName, "CreateGoal").execute(
      { objective: "fix tests" },
      ctx("sA"),
    );
    expect(created.output).toContain("active");
    const read = await getTool(byName, "GetGoal").execute({}, ctx("sA"));
    expect(read.output).toContain("fix tests");
    const other = await getTool(byName, "GetGoal").execute({}, ctx("sB"));
    expect(other.output).toContain("No goal");
  });

  it("UpdateGoal complete clears immediately", async () => {
    const { byName } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());
    const done = await getTool(byName, "UpdateGoal").execute(
      { status: "complete" },
      ctx(),
    );
    expect(done.output).toContain("completed");
  });

  it("UpdateGoal rejects invalid status", async () => {
    const { byName } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());
    await expect(
      Promise.resolve(
        getTool(byName, "UpdateGoal").execute({ status: "done" }, ctx()),
      ),
    ).rejects.toThrow();
  });

  it("SetGoalBudget sets one explicit turn or active-time dimension per call", async () => {
    const { byName, service } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());
    await getTool(byName, "SetGoalBudget").execute(
      { unit: "turns", value: 10 },
      ctx(),
    );
    await expect(
      getTool(byName, "SetGoalBudget").execute(
        { unit: "tokens", value: 1000 },
        ctx(),
      ),
    ).rejects.toThrow("Invalid unit");
    await getTool(byName, "SetGoalBudget").execute(
      { unit: "minutes", value: 5 },
      ctx(),
    );
    const snapshot = await service.getSnapshot("s1");
    expect(snapshot?.budget.turnBudget).toBe(10);
    expect(snapshot?.budget.wallClockBudgetMs).toBe(300_000);
    expect(getTool(byName, "SetGoalBudget").parametersJsonSchema).toMatchObject(
      {
        properties: {
          unit: {
            enum: ["turns", "milliseconds", "seconds", "minutes", "hours"],
          },
          value: { type: "number" },
        },
        required: ["value", "unit"],
      },
    );
  });

  it("SetGoalBudget rejects limits outside system boundaries", async () => {
    const { byName } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());

    await expect(
      Promise.resolve(
        getTool(byName, "SetGoalBudget").execute(
          { unit: "turns", value: 1001 },
          ctx(),
        ),
      ),
    ).rejects.toThrow("system safety cap");
    await expect(
      Promise.resolve(
        getTool(byName, "SetGoalBudget").execute(
          { unit: "milliseconds", value: 999 },
          ctx(),
        ),
      ),
    ).rejects.toThrow("1 second to 24 hours");
  });

  it("SetGoalBudget description forbids invented budgets", () => {
    const { byName } = makeTools();
    const description = getTool(byName, "SetGoalBudget").description;
    expect(description).toContain(
      "Never estimate, infer, recommend, or invent",
    );
    expect(description).toContain("user, system, or developer");
  });
});

describe("strict goal tool inputs", () => {
  it.each(["active", "paused"])(
    "rejects model status %j without changing an active goal",
    async (status) => {
      const { byName, service } = makeTools();
      await service.createGoal("s1", {
        actor: "user",
        objective: "continue work",
      });
      await expect(
        getTool(byName, "UpdateGoal").execute({ status }, ctx()),
      ).rejects.toThrow(/Invalid status/);
      expect((await service.getSnapshot("s1"))?.status).toBe("active");
    },
  );

  it.each([undefined, "", "  "])(
    "requires a nonblank blocked reason %j",
    async (reason) => {
      const { byName, service } = makeTools();
      await service.createGoal("s1", {
        actor: "user",
        objective: "continue work",
      });
      await expect(
        getTool(byName, "UpdateGoal").execute(
          { status: "blocked", reason },
          ctx(),
        ),
      ).rejects.toThrow(/non-empty.*reason|reason.*non-empty/);
      expect((await service.getSnapshot("s1"))?.status).toBe("active");
    },
  );

  it("rejects fractional turns instead of silently rounding a stated budget", async () => {
    const { byName, service } = makeTools();
    await service.createGoal("s1", {
      actor: "user",
      objective: "continue work",
    });
    await expect(
      getTool(byName, "SetGoalBudget").execute(
        { unit: "turns", value: 1.5 },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "invalid_budget" });
    expect((await service.getSnapshot("s1"))?.budgetLimits).toEqual({});
  });

  it("exposes only complete and blocked model transitions", () => {
    const { byName } = makeTools();
    expect(getTool(byName, "UpdateGoal").parametersJsonSchema).toMatchObject({
      properties: { status: { enum: ["complete", "blocked"] } },
    });
  });
});

describe("goal model instructions", () => {
  it("asks for one report each blocked turn and delegates counting to the backend", () => {
    const { byName } = makeTools();
    for (const instruction of [
      GOAL_CONTINUATION_CORE,
      PRIMARY_BASE_PROMPT_TEMPLATE,
      getTool(byName, "UpdateGoal").description,
    ]) {
      expect(instruction).toContain("each genuinely blocked turn");
      expect(instruction).toContain("1/3");
      expect(instruction).toContain("2/3");
      expect(instruction).toContain("independent work");
    }
  });
});

it("uses the trusted execution run identity for model mutations", async () => {
  const service = new GoalService({
    persistence: new InMemoryGoalPersistence(),
    executionControl: {
      interruptGoalExecution: (): Promise<void> => Promise.resolve(),
    },
    resolveMutationContext: (_sessionId, runId): GoalMutationContext =>
      runId === "trusted-user-run" ? { kind: "user" } : { kind: "invalid" },
  });
  const byName = new Map(
    createGoalTools(service).map((tool) => [tool.name, tool]),
  );
  const context = { ...ctx(), runId: "trusted-user-run" };
  await getTool(byName, "CreateGoal").execute(
    { objective: "finish task", runId: "forged" },
    context,
  );
  await getTool(byName, "SetGoalBudget").execute(
    { value: 10, unit: "turns", runId: "forged" },
    context,
  );
  expect((await service.getSnapshot("s1"))?.budgetLimits).toEqual({
    turnBudget: 10,
  });
  await getTool(byName, "UpdateGoal").execute(
    { status: "complete", runId: "forged" },
    context,
  );
  expect(await service.getSnapshot("s1")).toBeNull();
});
