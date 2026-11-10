import { createDatabaseMessageStore } from "../../core/message/database-store.js";
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

it("recovers dead, recycled and legacy owners without touching another live process", async () => {
  const db = getDatabase();
  run(main, "parent-run");
  const [dead, recycled, legacy, foreign, live] = await Promise.all(
    Array.from({ length: 5 }, () => open()),
  );
  await expect(archiveIdleRoot(db, main, Date.now())).rejects.toMatchObject({
    code: "SESSION_RUNNING",
  });
  db.prepare(
    "UPDATE session SET data=json_set(data, '$.sideChat.ownerId', 'previous-process') WHERE id IN (?,?)",
  ).run(dead.id, recycled.id);
  db.prepare(
    "UPDATE session SET data=json_remove(data, '$.sideChat.ownerId') WHERE id IN (?,?)",
  ).run(legacy.id, foreign.id);
  const pid = db.prepare(
    "UPDATE session SET data=json_set(data, '$.sideChat.ownerPid', ?) WHERE id=?",
  );
  pid.run(2147483647, dead.id);
  pid.run(process.pid + 1, foreign.id);
  run(dead.id, "orphan-run");
  expect(listSideChats(db, main).sideChats.map((s) => s.sideChatId)).toEqual([
    live.id,
  ]);
  await deleteOrphanSideChats(db, (pid) => pid !== 2147483647);
  expect(
    db
      .prepare<{ id: string }>("SELECT id FROM session")
      .all()
      .map((r) => r.id)
      .sort(),
  ).toEqual([main, foreign.id, live.id].sort());
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
  await expect(
    openSideChat(db, main, "/old-workspace", () => 20),
  ).rejects.toMatchObject({
    code: "SESSION_MOVED",
    targetDirectory: scope,
  });
  await expect(openSideChat(db, main, scope, () => 19)).rejects.toMatchObject({
    code: "SIDE_CHAT_UNSUPPORTED",
  });
  expect(listSideChats(db, main).sideChats).toHaveLength(0);
  const side = await openSideChat(db, main, scope, () => 20);
  const messages = createDatabaseMessageStore({ db });
  const before = await messages.listPageBySession(side.id);
  expect(before.messages).toHaveLength(2);
  expect(before.lastMessageId).toBe(side.sideChat.boundaryMessageId);
  // Cover the lowest UUID suffix a live prompt can use, in the boundary's millisecond.
  const nextId = "message_00000000-0000-4000-8000-000000000000";
  await messages.insertMessage({
    id: nextId,
    role: "user",
    agent: "build",
    sessionId: side.id,
    time: { created: 20 },
  });
  const newest = await messages.listPageBySession(side.id, { limit: 2 });
  expect(newest.messages.map(({ info }) => info.id)).toEqual([
    side.sideChat.boundaryMessageId,
    nextId,
  ]);
  expect(
    (await messages.listPageBySession(side.id, { before: newest.nextCursor }))
      .lastMessageId,
  ).toBe(before.firstMessageId);
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
