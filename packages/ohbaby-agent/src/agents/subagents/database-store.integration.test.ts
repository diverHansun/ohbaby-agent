import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import { DatabaseSubagentInstanceStore } from "./database-store.js";

const cleanupPaths: string[] = [];

async function tempDbPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-subagents-"));
  cleanupPaths.push(directory);
  return join(directory, "agent.db");
}

async function initFixture(): Promise<DatabaseSubagentInstanceStore> {
  initDatabase({ dbPath: await tempDbPath() });
  getDatabase()
    .prepare(
      `INSERT INTO ${schema.session.tableName}
        (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "child_1",
      "project_1",
      "/repo",
      "explore",
      "parent_1",
      "child",
      "active",
      1,
      1,
      0,
      "{}",
    );
  return new DatabaseSubagentInstanceStore({ db: getDatabase() });
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DatabaseSubagentInstanceStore", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "preserves invalid owner PID %s even when ownerId matches",
    async (ownerPid) => {
      await initFixture();
      const probe = vi.fn(() => false);
      const store = new DatabaseSubagentInstanceStore({
        db: getDatabase(),
        isOwnerAlive: probe,
      });
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
      const store = await initFixture();
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

  it("atomically appends durable queue entries without replacing prior prompts", async () => {
    const store = await initFixture();
    await store.create({
      contextScopeId: "scope_append",
      createdAt: 1,
      initialPrompt: "initial",
      parentSessionId: "parent_1",
      pendingQueue: [{ prompt: "initial" }],
      role: "explore",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_append",
      updatedAt: 1,
    });

    await Promise.all(
      ["second", "third", "fourth"].map((prompt, index) =>
        store.appendPendingQueue("subagent_append", { prompt }, index + 2),
      ),
    );

    await expect(
      store.get({ parentSessionId: "parent_1", subagentId: "subagent_append" }),
    ).resolves.toMatchObject({
      pendingQueue: [
        { prompt: "initial" },
        { prompt: "second" },
        { prompt: "third" },
        { prompt: "fourth" },
      ],
      updatedAt: 4,
    });
  });

  it("claims only once and prevents late run completion from overwriting close", async () => {
    const store = await initFixture();
    await store.create({
      contextScopeId: "scope_claim",
      createdAt: 1,
      initialPrompt: "inspect",
      parentSessionId: "parent_1",
      pendingQueue: [{ prompt: "inspect" }],
      role: "explore",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_claim",
      updatedAt: 1,
    });

    await expect(
      store.update("subagent_claim", {
        pendingQueue: undefined,
      }),
    ).rejects.toThrow("pendingQueue must not be undefined");

    await expect(
      store.claim("subagent_claim", {
        currentInput: { prompt: "inspect" },
        currentRunId: "run_1",
        pendingQueue: [],
        status: "running",
        updatedAt: 2,
      }),
    ).resolves.toMatchObject({ currentRunId: "run_1", status: "running" });
    await expect(
      store.claim("subagent_claim", {
        currentRunId: "run_2",
        status: "running",
        updatedAt: 3,
      }),
    ).resolves.toBeNull();
    await store.update("subagent_claim", {
      closedAt: 4,
      currentInput: undefined,
      currentRunId: undefined,
      lastRunId: "run_1",
      status: "cancelled",
      updatedAt: 4,
    });

    await expect(
      store.finishRun("subagent_claim", "run_1", {
        currentRunId: undefined,
        lastRunId: "run_1",
        status: "completed",
        updatedAt: 5,
      }),
    ).resolves.toMatchObject({ closedAt: 4, status: "cancelled" });
  });

  it("stores multiple subagents in one child session and marks active ones interrupted", async () => {
    const store = await initFixture();

    await store.create({
      contextScopeId: "subagent_a",
      createdAt: 1,
      currentInput: { prompt: "in flight", workdir: "/repo" },
      currentRunId: "run_a",
      initialPrompt: "first",
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "running",
      subagentId: "subagent_a",
      updatedAt: 1,
    });
    await store.create({
      contextScopeId: "subagent_b",
      createdAt: 2,
      initialPrompt: "second",
      parentSessionId: "parent_1",
      pendingQueue: [{ prompt: "queued" }],
      role: "research",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_b",
      updatedAt: 2,
    });

    await expect(store.listByParent("parent_1")).resolves.toMatchObject([
      {
        contextScopeId: "subagent_a",
        currentInput: { prompt: "in flight", workdir: "/repo" },
        sessionId: "child_1",
      },
      { contextScopeId: "subagent_b", sessionId: "child_1" },
    ]);
    await expect(
      store.get({ parentSessionId: "parent_1", subagentId: "subagent_b" }),
    ).resolves.toMatchObject({
      pendingQueue: [{ prompt: "queued" }],
      role: "research",
    });

    const interrupted = await store.markInterrupted({
      interruptedAt: 10,
      parentSessionId: "parent_1",
      recoverUnknownOwner: true,
    });

    expect(interrupted).toHaveLength(2);
    await expect(store.listByParent("parent_1")).resolves.toMatchObject([
      {
        completedAt: 10,
        currentInput: { prompt: "in flight", workdir: "/repo" },
        currentRunId: undefined,
        lastRunId: "run_a",
        interruptedAt: 10,
        status: "interrupted",
      },
      { interruptedAt: 10, status: "interrupted" },
    ]);
  });

  it("does not mark active subagents for live owners interrupted during startup recovery", async () => {
    initDatabase({ dbPath: await tempDbPath() });
    getDatabase()
      .prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "child_1",
        "project_1",
        "/repo",
        "explore",
        "parent_1",
        "child",
        "active",
        1,
        1,
        0,
        "{}",
      );
    const store = new DatabaseSubagentInstanceStore({
      db: getDatabase(),
      isOwnerAlive: (pid): boolean => pid === 111,
    });

    await store.create({
      contextScopeId: "live_scope",
      createdAt: 1,
      initialPrompt: "live",
      ownerId: "owner_live",
      ownerPid: 111,
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "running",
      subagentId: "subagent_live",
      updatedAt: 1,
    });
    await store.create({
      contextScopeId: "dead_scope",
      createdAt: 2,
      initialPrompt: "dead",
      ownerId: "owner_dead",
      ownerPid: 222,
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "pending",
      subagentId: "subagent_dead",
      updatedAt: 2,
    });
    await store.create({
      contextScopeId: "unknown_scope",
      createdAt: 3,
      initialPrompt: "unknown",
      parentSessionId: "parent_1",
      pendingQueue: [],
      role: "explore",
      sessionId: "child_1",
      status: "running",
      subagentId: "subagent_unknown",
      updatedAt: 3,
    });

    const interrupted = await store.markInterrupted({
      interruptedAt: 10,
      recoverUnknownOwner: true,
    });

    expect(interrupted.map((record) => record.subagentId).sort()).toEqual([
      "subagent_dead",
      "subagent_unknown",
    ]);
    await expect(store.listByParent("parent_1")).resolves.toMatchObject([
      { status: "running", subagentId: "subagent_live" },
      { interruptedAt: 10, status: "interrupted", subagentId: "subagent_dead" },
      {
        interruptedAt: 10,
        status: "interrupted",
        subagentId: "subagent_unknown",
      },
    ]);
  });

  it("uses owner identity and owner pid when recovering interrupted subagents", async () => {
    initDatabase({ dbPath: await tempDbPath() });
    getDatabase()
      .prepare(
        `INSERT INTO ${schema.session.tableName}
          (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "child_1",
        "project_1",
        "/repo",
        "explore",
        "parent_1",
        "child",
        "active",
        1,
        1,
        0,
        "{}",
      );
    const store = new DatabaseSubagentInstanceStore({
      db: getDatabase(),
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
      contextScopeId: "reused_scope",
      createdAt: 2,
      initialPrompt: "pid reused",
      ownerId: "owner_old_same_pid",
      ownerPid: 101,
      subagentId: "subagent_pid_reused",
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
    await store.create({
      ...base,
      contextScopeId: "other_live_scope",
      createdAt: 4,
      initialPrompt: "other live",
      ownerId: "owner_other_live",
      ownerPid: 202,
      subagentId: "subagent_other_live",
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
    const records = await store.listByParent("parent_1");
    expect(records).toEqual(
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
          subagentId: "subagent_pid_reused",
        }),
        expect.objectContaining({
          interruptedAt: 20,
          status: "interrupted",
          subagentId: "subagent_dead",
        }),
        expect.objectContaining({
          status: "running",
          subagentId: "subagent_other_live",
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
    const store = await initFixture();
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
    const store = await initFixture();
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
      const store = await initFixture();
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
    const store = await initFixture();
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
