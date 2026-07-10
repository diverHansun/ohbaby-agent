import { describe, expect, it } from "vitest";
import { InMemorySubagentInstanceStore } from "./in-memory-store.js";

describe("InMemorySubagentInstanceStore", () => {
  it("claims only once and prevents late run completion from overwriting close", async () => {
    const store = new InMemorySubagentInstanceStore();
    await store.create({
      contextScopeId: "scope_1",
      createdAt: 1,
      initialPrompt: "inspect",
      parentSessionId: "parent_1",
      pendingQueue: [{ prompt: "inspect" }],
      role: "explore",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_1",
      updatedAt: 1,
    });

    expect(() =>
      store.update("subagent_1", {
        status: undefined,
      }),
    ).toThrow("status must not be undefined");

    await expect(
      store.claim("subagent_1", {
        currentInput: { prompt: "inspect" },
        currentRunId: "run_1",
        pendingQueue: [],
        status: "running",
        updatedAt: 2,
      }),
    ).resolves.toMatchObject({ currentRunId: "run_1", status: "running" });
    await expect(
      store.claim("subagent_1", {
        currentRunId: "run_2",
        status: "running",
        updatedAt: 3,
      }),
    ).resolves.toBeNull();
    await store.update("subagent_1", {
      closedAt: 4,
      currentInput: undefined,
      currentRunId: undefined,
      lastRunId: "run_1",
      status: "cancelled",
      updatedAt: 4,
    });

    await expect(
      store.finishRun("subagent_1", "run_1", {
        currentRunId: undefined,
        lastRunId: "run_1",
        status: "completed",
        updatedAt: 5,
      }),
    ).resolves.toMatchObject({
      closedAt: 4,
      lastRunId: "run_1",
      status: "cancelled",
    });
  });

  it("uses owner identity and owner pid when recovering interrupted subagents", async () => {
    const store = new InMemorySubagentInstanceStore({
      isOwnerAlive: (pid): boolean => pid === 101 || pid === 202,
    });
    const base = {
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore" as const,
      sessionId: "child_1",
      status: "running" as const,
    };

    await store.create({
      ...base,
      contextScopeId: "current_scope",
      createdAt: 1,
      currentInput: { prompt: "current owner" },
      currentRunId: "run_current",
      initialPrompt: "current owner",
      ownerId: "owner_current",
      ownerPid: 101,
      subagentId: "subagent_current",
      updatedAt: 1,
    });
    await store.create({
      ...base,
      contextScopeId: "same_pid_scope",
      createdAt: 2,
      initialPrompt: "same pid other owner",
      ownerId: "owner_same_pid",
      ownerPid: 101,
      subagentId: "subagent_same_pid",
      updatedAt: 2,
    });
    await store.create({
      ...base,
      contextScopeId: "other_live_scope",
      createdAt: 3,
      initialPrompt: "other live",
      ownerId: "owner_other_live",
      ownerPid: 202,
      subagentId: "subagent_other_live",
      updatedAt: 3,
    });
    await store.create({
      ...base,
      contextScopeId: "dead_scope",
      createdAt: 4,
      initialPrompt: "dead",
      ownerId: "owner_dead",
      ownerPid: 303,
      subagentId: "subagent_dead",
      updatedAt: 4,
    });

    const interrupted = await store.markInterrupted({
      interruptedAt: 20,
      ownerId: "owner_current",
      ownerPid: 101,
    });

    expect(interrupted.map((record) => record.subagentId).sort()).toEqual([
      "subagent_current",
      "subagent_dead",
    ]);
    await expect(store.listByParent("parent_1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interruptedAt: 20,
          completedAt: 20,
          currentInput: { prompt: "current owner" },
          currentRunId: undefined,
          lastRunId: "run_current",
          status: "interrupted",
          subagentId: "subagent_current",
        }),
        expect.objectContaining({
          status: "running",
          subagentId: "subagent_same_pid",
        }),
        expect.objectContaining({
          status: "running",
          subagentId: "subagent_other_live",
        }),
        expect.objectContaining({
          interruptedAt: 20,
          status: "interrupted",
          subagentId: "subagent_dead",
        }),
      ]),
    );
  });
});
