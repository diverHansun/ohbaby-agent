import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDatabaseMessageStore,
  insertMessageRow,
  insertPartRow,
} from "../../core/message/database-store.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabaseCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import * as history from "../../services/session/copy-history.js";
import { createDatabaseSessionStore } from "../../services/session/database-store.js";
import { SessionEvent } from "../../services/session/events.js";
import { resolveSessionDisplayTitle } from "../../services/session/title-fallback.js";
import type { Session } from "../../services/session/types.js";
import { forkSession } from "./session-fork.js";

const directory = "/workspace";

beforeEach(() => {
  initDatabase({ dbPath: ":memory:" });
});
afterEach(closeDatabase);

function createSession(
  id: string,
  title: string,
  overrides: Partial<Session> = {},
): Promise<void> {
  return createDatabaseSessionStore().insert({
    id,
    title,
    projectId: "project",
    workingDirectory: directory,
    agentName: "build",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: false,
    ...overrides,
  });
}

async function writeTurn(
  sessionId: string,
  question: string,
  {
    runId = "done",
    start = 1,
    trigger = "user",
    running = false,
    contextScopeId,
  }: {
    runId?: string;
    start?: number;
    trigger?: "user" | "subagent";
    running?: boolean;
    contextScopeId?: string;
  } = {},
): Promise<void> {
  const db = getDatabase();
  db.prepare(
    "INSERT INTO run_ledger(run_id,session_id,context_scope_id,trigger,status,created_at,started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
  ).run(runId, sessionId, contextScopeId ?? null, trigger, start, start);
  for (const role of ["user", "assistant"] as const) {
    const messageId = `message_${runId}_${role}`;
    const at = role === "user" ? start : start + 1;
    const info = {
      id: messageId,
      role,
      agent: "build",
      sessionId,
      contextScopeId,
      runId,
      time: { created: at },
    };
    const part = {
      id: "part-" + messageId,
      sessionId,
      messageId,
      contextScopeId,
      type: "text" as const,
      text: role === "user" ? question : `Answer to ${question}`,
      orderIndex: 0,
    };
    if (trigger === "subagent" && role === "user") {
      await new DatabaseCurrentRunInputStore({
        db,
        now: (): number => at,
      }).acceptRuntimeInput({
        sessionId,
        runId,
        source: "subagent-status",
        sourceId: "child-report",
        inputId: `input_${runId}`,
        message: { info, parts: [part] },
      });
    } else {
      insertMessageRow(db, info);
      insertPartRow(db, part, at);
    }
  }
  if (!running) {
    db.prepare(
      "UPDATE run_ledger SET status='succeeded', ended_at=? WHERE run_id=?",
    ).run(start + 1, runId);
  }
  if (trigger === "user" && contextScopeId === undefined) {
    db.prepare(
      `INSERT INTO prompt_submission(prompt_id,scope_key,session_id,run_id,user_message_id,text,status,
      accepted_at,admission_order,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "prompt_" + runId,
      directory,
      sessionId,
      runId,
      `message_${runId}_user`,
      question,
      running ? "running" : "succeeded",
      start,
      start,
      start,
      start + 1,
    );
  }
}

it("copies the source through a promptless wake-up answer while a later turn is running", async () => {
  const db = getDatabase();
  await createSession("main", "Main");
  await writeTurn("main", "First question");
  await writeTurn("main", "Child finished", {
    runId: "wake",
    start: 3,
    trigger: "subagent",
  });
  const counts = (id: string): (number | undefined)[] =>
    ["prompt_submission", "run_ledger", "current_run_input"].map(
      (table) =>
        db
          .prepare<{
            n: number;
          }>(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`)
          .get(id)?.n,
    );
  const messages = db.prepare<{
    role: string;
    created_at: number;
    input_kind: string | null;
    type: string;
    text: string;
  }>(`SELECT m.role, m.created_at, json_extract(m.data,'$.runtimeInput.kind') AS input_kind,
       p.type, json_extract(p.data,'$.text') AS text FROM message m
       LEFT JOIN part p ON p.message_id=m.id WHERE m.session_id=? ORDER BY m.created_at, m.rowid, p.order_index`);
  const prefixCounts = counts("main");
  const prefix = messages.all("main");
  expect(prefixCounts).toEqual([1, 2, 1]);
  expect(prefix.map((row) => row.text)).toEqual([
    "First question",
    "Answer to First question",
    "Child finished",
    "Answer to Child finished",
  ]);
  expect(prefix[2].input_kind).toBe("subagent-status");

  await writeTurn("main", "Third question", {
    runId: "third",
    start: 5,
    running: true,
  });
  const latest = await forkSession(db, { sessionId: "main" }, directory);
  // Once the third answer finishes, only the explicit cut should still select the second.
  db.prepare(
    "UPDATE run_ledger SET status='succeeded', ended_at=6 WHERE run_id='third'",
  ).run();
  db.prepare(
    "UPDATE prompt_submission SET status='succeeded', ended_at=6 WHERE run_id='third'",
  ).run();
  const explicit = await forkSession(
    db,
    { sessionId: "main", runId: "wake" },
    directory,
  );
  for (const copy of [explicit, latest]) {
    expect(copy.fork).toEqual({ sourceSessionId: "main", sourceRunId: "wake" });
    expect(copy.stats).toEqual({
      messageCount: prefix.length,
      lastMessageAt: prefix.at(-1)?.created_at,
    });
    expect(counts(copy.id)).toEqual(prefixCounts);
    expect(messages.all(copy.id)).toEqual(prefix);
  }
});

it("numbers forks from the source display title across roots and persists the immediate source", async () => {
  const db = getDatabase();
  // This prefix was historically reserved for default session titles.
  const base = "New session - 🌿Flow_%[a]";
  await createSession("main", "New session - 2026-11-11T00:00:00.000Z");
  await writeTurn("main", base);
  await createSession("archived", base + " (2)", {
    status: "archived",
    workingDirectory: "/elsewhere",
  });
  await createSession("case", base.toLowerCase() + " (70)");
  await createSession("other", "New session - 🌿FlowXX[a] (80)");
  await createSession("suffix", base + " (90) extra");
  await createSession("child", base + " (98)", {
    isSubagent: true,
    parentId: "main",
  });
  await createSession("side", base + " (99)", {
    sideChat: { mainSessionId: "main", boundaryMessageId: "b", ownerPid: 1 },
  });

  const [first, second] = await Promise.all([
    forkSession(db, { sessionId: "main", runId: "done" }, directory),
    forkSession(db, { sessionId: "main" }, directory),
  ]);
  expect([first.title, second.title].sort()).toEqual([
    base + " (3)",
    base + " (4)",
  ]);
  expect(
    resolveSessionDisplayTitle({
      title: first.title,
      messages: await createDatabaseMessageStore().listBySession(first.id),
    }),
  ).toBe(first.title);
  const nested = await forkSession(db, { sessionId: first.id }, directory);
  expect(nested.title).toBe(base + " (5)");
  expect(nested.fork?.sourceSessionId).toBe(first.id);
  expect(nested.fork?.sourceRunId).toMatch(/^run_/u);
  expect(
    SessionEvent.Created.schema.parse({ session: first }).session.fork,
  ).toEqual({ sourceSessionId: "main", sourceRunId: "done" });
  const store = createDatabaseSessionStore();
  await store.update(first.id, { title: "Renamed" });
  expect((await store.get(first.id))?.fork).toEqual(first.fork);
});

it("rejects invalid sources without copying and rolls back on a partial history write", async () => {
  const db = getDatabase();
  await createSession("main", "Main");
  await writeTurn("main", "Question");
  await writeTurn("main", "Working", {
    runId: "active",
    start: 3,
    running: true,
  });
  await writeTurn("main", "Child work", {
    runId: "scoped",
    start: 5,
    contextScopeId: "child",
  });
  await createSession("empty", "Empty");
  await createSession("archived", "Archived", { status: "archived" });
  await createSession("child", "Child", { parentId: "main", isSubagent: true });
  await createSession("side", "Side chat 1", {
    sideChat: { mainSessionId: "main", boundaryMessageId: "b", ownerPid: 1 },
  });
  await createSession("moved", "Moved", { pendingWorkingDirectory: "/next" });
  const tables = [
    "session",
    "run_ledger",
    "message",
    "part",
    "prompt_submission",
    "current_run_input",
  ];
  const counts = (): unknown[] =>
    tables.map((table) =>
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
    );
  const before = counts();
  for (const [sessionId, code] of [
    ["missing", "SESSION_NOT_FOUND"],
    ["empty", "FORK_TARGET_INVALID"],
    ["archived", "SESSION_ARCHIVED"],
    ["child", "SESSION_NOT_ROOT"],
    ["side", "SIDE_CHAT_UNSUPPORTED"],
    ["moved", "SESSION_MOVED"],
  ]) {
    await expect(
      forkSession(db, { sessionId }, directory),
    ).rejects.toMatchObject({ code });
  }
  for (const runId of ["active", "scoped"]) {
    await expect(
      forkSession(db, { sessionId: "main", runId }, directory),
    ).rejects.toMatchObject({ code: "FORK_TARGET_INVALID" });
  }
  // Force a stale selection so the real history copier raises HistoryCutInvalidError on revalidation.
  const selection = vi
    .spyOn(history, "findForkableMainRun")
    .mockReturnValueOnce("stale-run");
  try {
    await expect(
      forkSession(db, { sessionId: "main", runId: "done" }, directory),
    ).rejects.toMatchObject({ code: "FORK_TARGET_INVALID" });
  } finally {
    selection.mockRestore();
  }
  db.exec(
    "CREATE TRIGGER block_copy BEFORE INSERT ON part BEGIN SELECT RAISE(ABORT, 'blocked part write'); END",
  );
  await expect(
    forkSession(db, { sessionId: "main" }, directory),
  ).rejects.toThrow("blocked part write");
  expect(counts()).toEqual(before);
});
