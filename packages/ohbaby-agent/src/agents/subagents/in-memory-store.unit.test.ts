import { describe, expect, it } from "vitest";
import { InMemorySubagentInstanceStore } from "./in-memory-store.js";

describe("InMemorySubagentInstanceStore", () => {
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
      initialPrompt: "current owner",
      ownerId: "owner_current",
      ownerPid: 101,
      subagentId: "subagent_current",
      updatedAt: 1,
    });
    await store.create({
      ...base,
      contextScopeId: "other_live_scope",
      createdAt: 2,
      initialPrompt: "other live",
      ownerId: "owner_other_live",
      ownerPid: 202,
      subagentId: "subagent_other_live",
      updatedAt: 2,
    });
    await store.create({
      ...base,
      contextScopeId: "dead_scope",
      createdAt: 3,
      initialPrompt: "dead",
      ownerId: "owner_dead",
      ownerPid: 303,
      subagentId: "subagent_dead",
      updatedAt: 3,
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
          status: "interrupted",
          subagentId: "subagent_current",
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
