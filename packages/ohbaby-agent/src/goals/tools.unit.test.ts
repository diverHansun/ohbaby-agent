import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { InMemoryGoalPersistence } from "./persistence.js";
import { GoalService } from "./service.js";
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

  it("UpdateGoal complete clears; paused records reason", async () => {
    const { byName } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());
    const done = await getTool(byName, "UpdateGoal").execute(
      { status: "complete" },
      ctx(),
    );
    expect(done.output).toContain("completed");
    await getTool(byName, "CreateGoal").execute({ objective: "b" }, ctx());
    const paused = await getTool(byName, "UpdateGoal").execute(
      { reason: "needs user input", status: "paused" },
      ctx(),
    );
    expect(paused.output).toContain("needs user input");
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

  it("SetGoalBudget sets one explicit turn, token, or active-time dimension per call", async () => {
    const { byName, service } = makeTools();
    await getTool(byName, "CreateGoal").execute({ objective: "a" }, ctx());
    await getTool(byName, "SetGoalBudget").execute(
      { unit: "turns", value: 10 },
      ctx(),
    );
    await getTool(byName, "SetGoalBudget").execute(
      { unit: "tokens", value: 1000 },
      ctx(),
    );
    await getTool(byName, "SetGoalBudget").execute(
      { unit: "minutes", value: 5 },
      ctx(),
    );
    const snapshot = await service.getSnapshot("s1");
    expect(snapshot?.budget.turnBudget).toBe(10);
    expect(snapshot?.budget.tokenBudget).toBe(1000);
    expect(snapshot?.budget.wallClockBudgetMs).toBe(300_000);
    expect(
      getTool(byName, "SetGoalBudget").parametersJsonSchema,
    ).toMatchObject({
      properties: {
        unit: {
          enum: [
            "turns",
            "tokens",
            "milliseconds",
            "seconds",
            "minutes",
            "hours",
          ],
        },
        value: { type: "number" },
      },
      required: ["value", "unit"],
    });
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
    expect(description).toContain("Never estimate, infer, recommend, or invent");
    expect(description).toContain("user, system, or developer");
  });
});
