import { DatabasePromptSubmissionStore } from "../../runtime/prompt-scheduler/database-store.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/database.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { archiveIdleRoot } from "../../services/session/archive.js";
import { openSideChat, listSideChats } from "./side-chat.js";
import { deleteOrphanSideChats } from "../../services/session/orphan-side-chats.js";

const main = "main";
const scope = "/workspace";
beforeEach(() => {
  initDatabase({ dbPath: ":memory:" });
  getDatabase()
    .prepare(
      "INSERT INTO session(id,project_id,working_directory,created_at,updated_at) VALUES (?, 'p',?,1,1)",
    )
    .run(main, scope);
});
afterEach(closeDatabase);

function run(session: string, id: string, trigger = "user"): void {
  getDatabase()
    .prepare(
      "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at) VALUES (?,?,?,'running',1)",
    )
    .run(id, session, trigger);
}

async function open(): Promise<{ text: string; id: string }> {
  const session = await openSideChat(getDatabase(), main, scope, Date.now);
  const row = getDatabase()
    .prepare<{
      text: string;
    }>(
      "SELECT json_extract(data, '$.text') AS text FROM part WHERE message_id = ?",
    )
    .get(session.sideChat.boundaryMessageId);
  if (!row) throw new Error("missing boundary");
  return { id: session.id, text: row.text };
}

it("includes the triggering goal, subagent handoff, or first queued prompt in the boundary", async () => {
  const db = getDatabase();
  await expect(open()).rejects.toMatchObject({
    code: "SIDE_CHAT_UNSUPPORTED",
    message: "Send a message first",
  });
  run(main, "goal", "goal");
  db.prepare(
    "INSERT INTO goal_record(session_id,seq,created_at,data) VALUES (?,1,1,?)",
  ).run(
    main,
    JSON.stringify({
      type: "create",
      goalId: "g",
      objective: "Verify the map",
    }),
  );
  expect((await open()).text).toContain("Verify the map");
  db.prepare("UPDATE run_ledger SET trigger='subagent'").run();
  expect((await open()).text).toContain("a result from a subagent");
  db.prepare("DELETE FROM run_ledger").run();
  db.prepare(
    `INSERT INTO prompt_submission(prompt_id,scope_key,session_id,user_message_id,text,status,client_request_id,created_at,updated_at,accepted_at,admission_order)
    VALUES ('q',?,?,'u','Just accepted','queued','client',1,1,1,1)`,
  ).run(scope, main);
  expect((await open()).text).toContain("Just accepted");
});

it("removes only dead owners, including active ledgers, and lists only this process's sessions", async () => {
  const db = getDatabase();
  run(main, "parent-run");
  const [first, second, live] = await Promise.all([open(), open(), open()]);
  expect(listSideChats(db, main).sideChats.map((s) => s.title)).toEqual([
    "Side chat 1",
    "Side chat 2",
    "Side chat 3",
  ]);
  await expect(archiveIdleRoot(db, main, Date.now())).rejects.toMatchObject({
    code: "SESSION_RUNNING",
  });
  db.prepare(
    "UPDATE session SET data=json_set(data, '$.sideChat.ownerPid', 123456789) WHERE id IN (?,?)",
  ).run(first.id, second.id);
  run(first.id, "orphan-run");
  expect(listSideChats(db, main).sideChats.map((s) => s.sideChatId)).toEqual([
    live.id,
  ]);
  await deleteOrphanSideChats(db, (pid) => pid === process.pid);
  expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
    { id: main },
    { id: live.id },
  ]);
  expect(db.prepare("SELECT run_id FROM run_ledger").all()).toEqual([
    { run_id: "parent-run" },
  ]);
});

it("rolls back a future-dated cut and orders the boundary last when the clock catches up", async () => {
  const db = getDatabase();
  run(main, "done");
  db.prepare("UPDATE run_ledger SET status='succeeded', ended_at=2").run();
  db.prepare(
    "INSERT INTO message(id,session_id,role,agent,created_at,updated_at,data) VALUES ('m',?,'user','build',20,20,?)",
  ).run(
    main,
    JSON.stringify({
      id: "m",
      sessionId: main,
      role: "user",
      agent: "build",
      runId: "done",
      time: { created: 20 },
    }),
  );
  await expect(openSideChat(db, main, scope, () => 19)).rejects.toMatchObject({
    code: "SIDE_CHAT_UNSUPPORTED",
  });
  expect(listSideChats(db, main).sideChats).toHaveLength(0);
  const side = await openSideChat(db, main, scope, () => 20);
  const ordered = db
    .prepare<{
      id: string;
    }>("SELECT id FROM message WHERE session_id=? ORDER BY created_at,id")
    .all(side.id);
  expect(ordered.at(-1)?.id).toBe(side.sideChat.boundaryMessageId);
  // A prompt can be admitted in the millisecond that the side chat opens.
  const nextId = "message_00000000-0000-4000-8000-000000000000";
  db.prepare(
    "INSERT INTO message(id,session_id,role,agent,created_at,updated_at,data) VALUES (?,?,'user','build',20,20,'{}')",
  ).run(nextId, side.id);
  expect(
    db
      .prepare<{ id: string }>(
        "SELECT id FROM message WHERE session_id=? ORDER BY created_at,id",
      )
      .all(side.id)
      .map((row) => row.id),
  ).toEqual([...ordered.map((row) => row.id), nextId]);
});

it("retains a main session that became busy after the archive preflight", async () => {
  const db = getDatabase();
  run(main, "r");
  await expect(archiveIdleRoot(db, main, Date.now())).rejects.toMatchObject({
    code: "SESSION_RUNNING",
  });
  db.prepare("UPDATE run_ledger SET status='interrupted'").run();
  await archiveIdleRoot(db, main, Date.now());
  const store = new DatabasePromptSubmissionStore({ db });
  await expect(
    store.accept({
      scopeKey: scope,
      sessionId: main,
      promptId: "late",
      userMessageId: "u",
      text: "late",
      clientRequestId: "late",
      maxQueuedPrompts: 10,
    }),
  ).rejects.toMatchObject({ code: "SESSION_ARCHIVED" });
  await expect(
    createDatabaseRunLedger({ db }).createPending({
      sessionId: main,
      runId: "late",
      triggerSource: "goal",
    }),
  ).rejects.toMatchObject({ code: "SESSION_ARCHIVED" });
});
