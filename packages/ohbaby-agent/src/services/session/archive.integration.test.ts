import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../database/index.js";
import { readSessionRow } from "./database-store.js";
import { deleteArchivedSession, restoreArchivedSession } from "./archive.js";
import { listGlobalSessions } from "./global-query.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-archive-"));
  initDatabase({ dbPath: join(root, "agent.db") });
});
afterEach(async () => {
  closeDatabase();
  await rm(root, { recursive: true, force: true });
});
function addSession(
  id: string,
  parent: string | null = null,
  status = "archived",
): void {
  getDatabase()
    .prepare(
      `INSERT INTO session
    (id, project_id, working_directory, workspace_directory, pending_working_directory, parent_id, title, status, created_at, updated_at, data)
    VALUES (?, 'global', '/work', '/workspace', '/next', ?, ?, ?, 1, 2, '{}')`,
    )
    .run(id, parent, id, status);
}
const restoreInput = {
  workspaceAvailable: true,
  nextDirectoryExists: true,
  defaultDirectory: "/default",
  now: 100,
};

describe("archived session lifecycle", () => {
  it.each([
    [true, true, "/workspace", "/next"],
    [false, true, undefined, "/next"],
    [true, false, "/workspace", "/workspace"],
    [false, false, undefined, "/default"],
  ] as const)(
    "restores with workspace=%s and next directory=%s",
    async (
      workspaceAvailable,
      nextDirectoryExists,
      workspaceDirectory,
      pendingWorkingDirectory,
    ) => {
      addSession("root");
      const session = await restoreArchivedSession("root", {
        ...restoreInput,
        workspaceAvailable,
        nextDirectoryExists,
      });
      expect(session).toMatchObject({
        status: "active",
        updatedAt: 100,
        workingDirectory: "/work",
        pendingWorkingDirectory,
      });
      expect(session.workspaceDirectory).toBe(workspaceDirectory);
    },
  );

  it.each(["restore", "delete"])(
    "%s rejects missing, active and child sessions without mutations",
    async (operation) => {
      addSession("root", null, "active");
      addSession("child", "root");
      const before = getDatabase().prepare("SELECT * FROM session").all();
      for (const [id, code] of [
        ["missing", "SESSION_NOT_FOUND"],
        ["root", "SESSION_NOT_ARCHIVED"],
        ["child", "SESSION_NOT_ROOT"],
      ]) {
        const result =
          operation === "restore"
            ? restoreArchivedSession(id, restoreInput)
            : deleteArchivedSession(id);
        await expect(result).rejects.toMatchObject({ code });
      }
      expect(getDatabase().prepare("SELECT * FROM session").all()).toEqual(
        before,
      );
    },
  );

  it("lists archived roots in hidden workspaces with stable pagination", () => {
    addSession("a");
    addSession("b");
    addSession("child", "a");
    addSession("active", null, "active");
    getDatabase().exec(
      `INSERT INTO workspace_registry VALUES ('/workspace', 'hidden', 0, 1, 1, 1)`,
    );
    const first = listGlobalSessions({ status: "archived", limit: 1 });
    expect(first.sessions.map((s) => s.id)).toEqual(["b"]);
    const second = listGlobalSessions({
      status: "archived",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeUndefined();
    expect(listGlobalSessions().sessions).toEqual([]);
  });

  it("deletes the entire tree and all dependent records, preserving unrelated data", async () => {
    addSession("root");
    addSession("child", "root", "active");
    addSession("grandchild", "child", "active");
    addSession("unrelated");
    const db = getDatabase();
    for (const id of ["root", "child", "grandchild", "unrelated"]) {
      db.prepare(
        "INSERT INTO message (id, session_id, role, created_at, updated_at, data) VALUES (?, ?, 'user', 1, 1, '{}')",
      ).run(id, id);
      db.prepare(
        "INSERT INTO part (id, message_id, session_id, type, created_at, updated_at, data) VALUES (?, ?, ?, 'text', 1, 1, '{}')",
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO run_ledger (run_id, session_id, trigger, status, created_at) VALUES (?, ?, 'user', 'succeeded', 1)",
      ).run(id, id);
      db.prepare(
        "INSERT INTO current_run_input (input_id, run_id, session_id, source, source_id, message_id, accepted_at, data) VALUES (?, ?, ?, 'user-steer', ?, ?, 1, '{}')",
      ).run(id, id, id, id, id);
      db.prepare("INSERT INTO current_run_request_owner VALUES (?, ?)").run(
        id,
        id,
      );
      db.prepare(
        "INSERT INTO snapshot_checkpoint (checkpoint_id, session_id, run_id, turn_id, workdir, created_at) VALUES (?, ?, ?, 'turn', '/work', 1)",
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO snapshot_patch (patch_id, checkpoint_id, created_at) VALUES (?, ?, 1)",
      ).run(id, id);
      db.prepare("INSERT INTO goal_record VALUES (?, 1, 1, '{}')").run(id);
      db.prepare(
        `INSERT INTO prompt_submission (prompt_id, scope_key, session_id, user_message_id, text, status, created_at, updated_at, accepted_at, admission_order) VALUES (?, '/work', ?, ?, 'hello', 'retained', 1, 1, 1, 1)`,
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO prompt_resubmission VALUES ('/work', ?, ?, 'hello', '{}')",
      ).run(id, id);
      db.prepare(
        `INSERT INTO subagent_instance (subagent_id, session_id, context_scope_id, parent_session_id, role, initial_prompt, created_at, updated_at) VALUES (?, 'unrelated', ?, ?, 'agent', 'hello', 1, 1)`,
      ).run(id, id, id);
      db.prepare(
        `INSERT INTO subagent_execution (execution_id, request_id, parent_session_id, requester_scope_id, requester_run_id, root_session_id, root_run_id, subagent_id, mode, prompt, created_at, status, child_session_id, updated_at, artifact, delivery) VALUES (?, ?, ?, 'scope', ?, ?, 'run', 'agent', 'background', 'hello', 1, 'completed', ?, 1, '{}', '{}')`,
      ).run(
        id,
        id,
        id === "child" ? "unrelated" : id,
        id,
        id === "child" ? "root" : "unrelated",
        id === "grandchild" ? "grandchild" : "unrelated",
      );
    }
    const result = await deleteArchivedSession("root", db);
    expect([...result.sessionIds].sort()).toEqual([
      "child",
      "grandchild",
      "root",
    ]);
    expect(result.checkpoints).toHaveLength(3);
    for (const table of [
      "session",
      "message",
      "part",
      "run_ledger",
      "current_run_input",
      "current_run_request_owner",
      "snapshot_checkpoint",
      "snapshot_patch",
      "goal_record",
      "prompt_submission",
      "prompt_resubmission",
      "subagent_instance",
      "subagent_execution",
    ]) {
      expect(
        db.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
        table,
      ).toEqual({ count: 1 });
    }
    expect(readSessionRow(db, "unrelated")?.status).toBe("archived");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls back the whole deletion if a database write fails", async () => {
    addSession("root");
    getDatabase().exec(
      "INSERT INTO goal_record VALUES ('root', 1, 1, '{}'); CREATE TRIGGER reject_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    await expect(deleteArchivedSession("root")).rejects.toThrow("injected");
    expect(readSessionRow(getDatabase(), "root")).not.toBeNull();
    expect(
      getDatabase().prepare("SELECT * FROM goal_record").all(),
    ).toHaveLength(1);
  });

  it.each(["run", "queued", "starting"])(
    "refuses deletion of legacy archived sessions with %s work",
    async (kind) => {
      addSession("root");
      addSession("child", "root", "active");
      const db = getDatabase();
      if (kind === "run")
        db.exec(
          "INSERT INTO run_ledger (run_id, session_id, trigger, status, created_at) VALUES ('busy', 'child', 'user', 'running', 1)",
        );
      else
        db.prepare(
          "INSERT INTO prompt_submission (prompt_id, scope_key, session_id, user_message_id, text, status, created_at, updated_at, accepted_at, admission_order) VALUES ('p', '/other', 'root', 'm', '', ?, 1, 1, 1, 1)",
        ).run(kind);
      await expect(deleteArchivedSession("root", db)).rejects.toMatchObject({
        name: "SessionRunBusyError",
      });
      expect(readSessionRow(db, "root")).not.toBeNull();
    },
  );
});

it("deletes more descendants than a bound SQL parameter list would allow", async () => {
  addSession("root");
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 1200; index += 1)
      addSession(`child-${String(index)}`, "root", "active");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const result = await deleteArchivedSession("root", db);
  expect(result.sessionIds).toHaveLength(1201);
  expect(db.prepare("SELECT count(*) AS count FROM session").get()).toEqual({
    count: 0,
  });
});
