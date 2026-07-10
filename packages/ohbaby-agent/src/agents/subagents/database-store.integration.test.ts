import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      "subagent_pid_reused",
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
          interruptedAt: 20,
          status: "interrupted",
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
