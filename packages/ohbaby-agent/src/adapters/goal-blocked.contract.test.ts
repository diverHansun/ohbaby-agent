import { afterEach, expect, it } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { InMemoryGoalPersistence } from "../goals/persistence.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

it.each([undefined, 20])(
  "U5 projects durable blocked metrics consistently (turnBudget=%s)",
  async (turnBudget) => {
    const persistence = new InMemoryGoalPersistence();
    await persistence.append("blocked-session", {
      type: "create",
      goalId: "blocked-goal",
      objective: "Wait for user choice",
      budgetLimits: turnBudget === undefined ? {} : { turnBudget },
    });
    await persistence.append("blocked-session", {
      type: "update",
      goalId: "blocked-goal",
      status: "blocked",
      pauseReason: "Need a database choice",
      turnsUsed: 7,
      wallClockMs: 192000,
      tokensUsed: 1234,
    });
    const client = createInProcessUiBackendClient({
      goalPersistence: persistence,
      initialSnapshot: {
        activeSessionId: "blocked-session",
        sessions: [
          {
            id: "blocked-session",
            title: "Existing session",
            messages: [],
            createdAt: "2026-10-15T00:00:00.000Z",
            updatedAt: "2026-10-15T00:00:00.000Z",
          },
        ],
        permissions: [],
        runs: [],
        status: { kind: "idle" },
      },
    });
    clients.push(client);
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => events.push(event));
    await client.initializeSession("blocked-session");
    const goal = {
      status: "blocked",
      objective: "Wait for user choice",
      pauseReason: "Need a database choice",
      turnsUsed: 7,
      wallClockMs: 192000,
      ...(turnBudget === undefined ? {} : { turnBudget }),
    };
    expect(
      (await client.getSessionView({ sessionId: "blocked-session" })).goal,
    ).toEqual({ status: "ready", value: goal });
    expect((await client.getSnapshot()).goals).toEqual([
      { sessionId: "blocked-session", goal },
    ]);
    await client.executeCommand({
      commandId: "goal",
      path: ["goal"],
      clientInvocationId: "blocked-status",
      raw: "/goal status",
      rawArgs: "status",
      argv: ["status"],
      sessionId: "blocked-session",
      surface: "web",
    });
    expect(
      events.filter((event) => event.type === "goal.updated").at(-1),
    ).toMatchObject({ sessionId: "blocked-session", goal });
    expect(await persistence.list("blocked-session")).toHaveLength(2);
  },
);
