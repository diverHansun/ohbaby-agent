import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { ensureDefaultWorkspaceDirectory } from "../../paths/index.js";
import { DatabasePromptSubmissionStore } from "../../runtime/prompt-scheduler/database-store.js";
import { closeDatabase, getDatabase, initDatabase } from "../database/index.js";
import { INITIAL_MIGRATIONS } from "../database/migrations.js";
import {
  createDatabaseSessionStore,
  readSessionRow,
  writeSessionProjectBinding,
} from "./database-store.js";
import { createSessionManager } from "./manager.js";
import {
  commitSessionProjectMove,
  planSessionProjectMove,
  SessionProjectMoveError,
} from "./project-move.js";
import type { SessionManager } from "./types.js";

let root: string;
let manager: SessionManager;

function createManager(): SessionManager {
  let clock = 1_000;
  return createSessionManager({
    bus: createBus(),
    store: createDatabaseSessionStore(),
    messageCleaner: { removeMessages: () => Promise.resolve() },
    projectResolver: {
      fromDirectory: (directory) => ({ id: "global", rootPath: directory }),
    },
    now: () => (clock += 10),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-project-binding-"));
  vi.stubEnv("OHBABY_HOME", join(root, ".ohbaby"));
  initDatabase({ dbPath: join(root, "agent.db") });
  manager = createManager();
});

afterEach(async () => {
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function queuePrompt(input: {
  readonly promptId: string;
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly status?: string;
  readonly createdAt: number;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO prompt_submission
        (prompt_id, client_request_id, scope_key, session_id, user_message_id,
         text, status, created_at, updated_at, owner_id, owner_pid,
         accepted_at, admission_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner_a', ?, ?, ?)`,
    )
    .run(
      input.promptId,
      `request_${input.promptId}`,
      input.scopeKey,
      input.sessionId,
      `message_${input.promptId}`,
      `text ${input.promptId}`,
      input.status ?? "queued",
      input.createdAt,
      input.createdAt,
      process.pid,
      input.createdAt,
      input.createdAt,
    );
}

function moveErrorCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    return error instanceof SessionProjectMoveError ? error.code : undefined;
  }
  return undefined;
}

describe("session project binding", () => {
  it("leaves default-workspace sessions without a project and keeps subagents with their parent", async () => {
    const defaultWorkspace = await ensureDefaultWorkspaceDirectory();
    const chat = await manager.create(defaultWorkspace);
    const project = await manager.create("/repo/a");
    const child = await manager.create("/repo/a", { parentId: project.id });

    expect(chat.projectDirectory).toBeUndefined();
    expect(project.projectDirectory).toBe("/repo/a");
    expect(child.projectDirectory).toBe("/repo/a");
    expect(readSessionRow(getDatabase(), chat.id)?.projectDirectory).toBe(
      undefined,
    );
  });

  it("backfills existing sessions once and keeps a later removal", () => {
    closeDatabase();
    const dbPath = join(root, "legacy.db");
    initDatabase({
      dbPath,
      migrations: INITIAL_MIGRATIONS.filter(
        (migration) => migration.version !== "025_session_project_binding",
      ),
    });
    getDatabase()
      .prepare(
        `INSERT INTO session (id, project_id, project_root, status, created_at, updated_at)
         VALUES ('legacy', 'global', '/repo/legacy', 'active', 1, 1)`,
      )
      .run();
    closeDatabase();

    initDatabase({ dbPath });
    const migrated = readSessionRow(getDatabase(), "legacy");
    expect(migrated?.projectRoot).toBe("/repo/legacy");
    expect(migrated?.projectDirectory).toBe("/repo/legacy");

    writeSessionProjectBinding(getDatabase(), "legacy", {}, 2);
    closeDatabase();
    initDatabase({ dbPath });
    expect(readSessionRow(getDatabase(), "legacy")?.projectDirectory).toBe(
      undefined,
    );
  });

  it("moves to another project at the next turn and leaves a project keeping the directory", async () => {
    const session = await manager.create("/repo/a");

    const toB = planSessionProjectMove(session.id, "/repo/b");
    expect(toB).toMatchObject({
      binding: { projectDirectory: "/repo/b", pendingProjectRoot: "/repo/b" },
      queueRoot: "/repo/b",
      needsQueueHandover: false,
    });
    const moved = await commitSessionProjectMove(toB);
    expect(moved).toMatchObject({
      id: session.id,
      projectRoot: "/repo/a",
      projectDirectory: "/repo/b",
      pendingProjectRoot: "/repo/b",
    });

    // Leaving cancels the change that has not started and keeps /repo/a.
    const removed = await commitSessionProjectMove(
      planSessionProjectMove(session.id, null),
    );
    expect(removed.projectRoot).toBe("/repo/a");
    expect(removed.projectDirectory).toBeUndefined();
    expect(removed.pendingProjectRoot).toBeUndefined();

    // Moving back to the directory it runs in needs no pending change.
    const back = planSessionProjectMove(session.id, "/repo/a");
    expect(back.binding).toEqual({ projectDirectory: "/repo/a" });
  });

  it("applies a pending directory only for the turn that runs there", async () => {
    const session = await manager.create("/repo/a");
    await commitSessionProjectMove(
      planSessionProjectMove(session.id, "/repo/b"),
    );

    const started = await manager.recordExecutionRoot(session.id, "/repo/b");
    expect(started.projectRoot).toBe("/repo/b");
    expect(started.pendingProjectRoot).toBeUndefined();
    expect(started.projectDirectory).toBe("/repo/b");

    // A newer target chosen while a turn starts elsewhere is kept.
    await commitSessionProjectMove(
      planSessionProjectMove(session.id, "/repo/c"),
    );
    const other = await manager.recordExecutionRoot(session.id, "/repo/b");
    expect(other.pendingProjectRoot).toBe("/repo/c");
  });

  it("lists a moving session in both its current and target workspace", async () => {
    const session = await manager.create("/repo/a");
    await commitSessionProjectMove(
      planSessionProjectMove(session.id, "/repo/b"),
    );

    const inA = await manager.listByProjectRoot("/repo/a");
    const inB = await manager.listByProjectRoot("/repo/b");
    expect(inA.map((item) => item.id)).toEqual([session.id]);
    expect(inB.map((item) => item.id)).toEqual([session.id]);

    await manager.recordExecutionRoot(session.id, "/repo/b");
    await expect(manager.listByProjectRoot("/repo/a")).resolves.toEqual([]);
  });

  it("hands queued prompts to the target workspace in order and leaves started prompts alone", async () => {
    const session = await manager.create("/repo/a");
    queuePrompt({
      promptId: "p1",
      sessionId: session.id,
      scopeKey: "/repo/a",
      createdAt: 10,
    });
    queuePrompt({
      promptId: "p2",
      sessionId: session.id,
      scopeKey: "/repo/a",
      createdAt: 20,
    });
    queuePrompt({
      promptId: "running",
      sessionId: session.id,
      scopeKey: "/repo/a",
      status: "running",
      createdAt: 5,
    });

    const plan = planSessionProjectMove(session.id, "/repo/b");
    expect(plan.needsQueueHandover).toBe(true);

    const target = new DatabasePromptSubmissionStore({
      ownerId: "owner_b",
      ownerPid: process.pid,
    });
    await target.adoptQueuedSession({
      sessionId: session.id,
      scopeKey: "/repo/b",
      beforeAdopt: () => {
        writeSessionProjectBinding(getDatabase(), session.id, plan.binding, 99);
      },
    });

    const queued = await target.listQueued("/repo/b");
    expect(queued.map((prompt) => prompt.promptId)).toEqual(["p1", "p2"]);
    await expect(target.get("running")).resolves.toMatchObject({
      scopeKey: "/repo/a",
      status: "running",
    });
    expect(readSessionRow(getDatabase(), session.id)?.pendingProjectRoot).toBe(
      "/repo/b",
    );
  });

  it("returns queued prompts to the kept directory when leaving before the change starts", async () => {
    const session = await manager.create("/repo/a");
    writeSessionProjectBinding(
      getDatabase(),
      session.id,
      { projectDirectory: "/repo/b", pendingProjectRoot: "/repo/b" },
      50,
    );
    queuePrompt({
      promptId: "p1",
      sessionId: session.id,
      scopeKey: "/repo/b",
      createdAt: 60,
    });

    const leave = planSessionProjectMove(session.id, null);
    expect(leave).toMatchObject({
      binding: {},
      queueRoot: "/repo/a",
      needsQueueHandover: true,
    });
  });

  it("rejects moving subagent and archived sessions", async () => {
    const parent = await manager.create("/repo/a");
    const child = await manager.create("/repo/a", { parentId: parent.id });
    expect(() => planSessionProjectMove(child.id, "/repo/b")).toThrow(
      SessionProjectMoveError,
    );
    await manager.update(parent.id, { status: "archived" });
    expect(
      moveErrorCode(() => planSessionProjectMove(parent.id, "/repo/b")),
    ).toBe("SESSION_ARCHIVED");
    expect(moveErrorCode(() => planSessionProjectMove("missing", null))).toBe(
      "SESSION_NOT_FOUND",
    );
  });
});
