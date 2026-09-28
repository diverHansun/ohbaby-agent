import { describe, expect, it, vi } from "vitest";
import { InMemorySubagentInstanceStore } from "./in-memory-store.js";

describe("InMemorySubagentInstanceStore", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "preserves invalid owner PID %s even when ownerId matches",
    async (ownerPid) => {
      const probe = vi.fn(() => false);
      const store = new InMemorySubagentInstanceStore({ isOwnerAlive: probe });
      await store.create({
        subagentId: "unknown",
        contextScopeId: "scope",
        sessionId: "child_1",
        parentSessionId: "parent_1",
        role: "explore",
        initialPrompt: "inspect",
        status: "running",
        ownerId: "owner",
        ownerPid,
        currentRunId: "run",
        pendingQueue: [],
        createdAt: 1,
        updatedAt: 1,
      });
      expect(await store.markInterrupted({ ownerId: "owner" })).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
      expect(
        (
          await store.get({
            subagentId: "unknown",
            parentSessionId: "parent_1",
          })
        )?.status,
      ).toBe("running");
      expect(
        await store.markInterrupted({ recoverUnknownOwner: true }),
      ).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "admits cancelled instances only when not closed (closed=%s)",
    async (closed) => {
      const store = new InMemorySubagentInstanceStore();
      await store.create({
        contextScopeId: "cancelled_scope",
        createdAt: 1,
        initialPrompt: "first",
        parentSessionId: "parent_1",
        pendingQueue: [],
        role: "explore",
        sessionId: "child_1",
        status: "cancelled",
        subagentId: "cancelled_child",
        updatedAt: 1,
        ...(closed ? { closedAt: 0 } : {}),
      });
      const queued = await store.appendPendingQueue(
        "cancelled_child",
        { prompt: "resume" },
        2,
      );
      const claimed = await store.claim("cancelled_child", {
        currentRunId: "next",
        status: "running",
        updatedAt: 3,
      });
      if (closed) {
        expect(queued).toBeNull();
        expect(claimed).toBeNull();
      } else {
        expect(queued?.pendingQueue).toEqual([{ prompt: "resume" }]);
        expect(claimed?.status).toBe("running");
      }
    },
  );

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

describe("recoverExecutionInputs", () => {
  const base = {
    subagentId: "recovery-child",
    parentSessionId: "parent_1",
    sessionId: "child_1",
    contextScopeId: "recovery-scope",
    role: "generic" as const,
    initialPrompt: "old",
    status: "running" as const,
    ownerId: "old-owner",
    ownerPid: 101,
    currentRunId: "old-run",
    currentInput: {
      executionId: "old-execution",
      rootRunId: "old-root",
      prompt: "old",
    },
    pendingQueue: [
      {
        executionId: "old-pending",
        rootRunId: "old-root",
        prompt: "old pending",
      },
      { executionId: "other", rootRunId: "other-root", prompt: "other" },
      { prompt: "legacy without identity" },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  const recovery = {
    subagentId: base.subagentId,
    executionIds: ["old-execution"],
    rootRunIds: ["old-root"],
    expectedOwnerId: "old-owner",
    expectedOwnerPid: 101,
    expectedCurrentRunId: "old-run",
    at: 100,
  };

  it("removes only old inputs and seals its original current run once", async () => {
    const store = new InMemorySubagentInstanceStore();
    await store.create(base);
    const recovered = await store.recoverExecutionInputs(recovery);
    expect(recovered).toMatchObject({
      status: "interrupted",
      interruptedAt: 100,
      completedAt: 100,
      lastRunId: "old-run",
      pendingQueue: base.pendingQueue.slice(1),
    });
    expect(recovered.currentInput).toBeUndefined();
    expect(recovered.currentRunId).toBeUndefined();
    expect(
      await store.recoverExecutionInputs({ ...recovery, at: 200 }),
    ).toEqual(recovered);
  });

  it("preserves a newly claimed run and freshly appended inputs when stale recovery resumes", async () => {
    const store = new InMemorySubagentInstanceStore();
    await store.create(base);
    await store.recoverExecutionInputs(recovery);
    const nextInput = {
      executionId: "new-execution",
      rootRunId: "new-root",
      prompt: "new",
    };
    await store.claim(base.subagentId, {
      status: "running",
      currentRunId: "new-run",
      currentInput: nextInput,
      ownerId: "new-owner",
      ownerPid: 202,
      updatedAt: 101,
    });
    const newPending = {
      executionId: "new-pending",
      rootRunId: "new-root",
      prompt: "new pending",
    };
    await store.appendPendingQueue(base.subagentId, base.pendingQueue[0], 102);
    await store.appendPendingQueue(base.subagentId, newPending, 103);
    const recovered = await store.recoverExecutionInputs({
      ...recovery,
      at: 200,
    });
    expect(recovered).toMatchObject({
      status: "running",
      ownerId: "new-owner",
      ownerPid: 202,
      currentRunId: "new-run",
      currentInput: nextInput,
      pendingQueue: [...base.pendingQueue.slice(1), newPending],
    });
    expect(
      await store.recoverExecutionInputs({ ...recovery, at: 300 }),
    ).toEqual(recovered);
  });

  it.each(["ownerId", "ownerPid", "currentRunId"] as const)(
    "rejects changed %s while the same old execution is still current without partially removing its queue",
    async (field) => {
      const store = new InMemorySubagentInstanceStore();
      await store.create(base);
      const changed = await store.update(
        base.subagentId,
        field === "ownerPid" ? { ownerPid: 202 } : { [field]: "changed" },
      );
      await expect(store.recoverExecutionInputs(recovery)).rejects.toThrow(
        /recovery.*conflict/i,
      );
      expect(
        await store.get({
          subagentId: base.subagentId,
          parentSessionId: base.parentSessionId,
        }),
      ).toEqual(changed);
    },
  );

  it("does not turn an existing terminal result into an interruption", async () => {
    const store = new InMemorySubagentInstanceStore();
    await store.create({
      ...base,
      status: "completed",
      output: "saved result",
      completedAt: 25,
      pendingQueue: [],
    });
    const existing = await store.get({
      subagentId: base.subagentId,
      parentSessionId: base.parentSessionId,
    });
    expect(await store.recoverExecutionInputs(recovery)).toEqual(existing);
  });
});
