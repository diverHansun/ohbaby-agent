import { afterEach, beforeEach, expect, it } from "vitest";
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

function writeTurn(sessionId: string, question: string): void {
  const db = getDatabase();
  db.prepare(
    "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,ended_at) VALUES ('done', ?, 'user','succeeded',1,2)",
  ).run(sessionId);
  for (const role of ["user", "assistant"] as const) {
    const messageId = `message_${role}`;
    const at = role === "user" ? 1 : 2;
    insertMessageRow(db, {
      id: messageId,
      role,
      agent: "build",
      sessionId,
      runId: "done",
      time: { created: at },
    });
    insertPartRow(
      db,
      {
        id: "part-" + messageId,
        sessionId,
        messageId,
        type: "text",
        text: role === "user" ? question : "Answer",
        orderIndex: 0,
      },
      at,
    );
  }
}

it("numbers forks from the source display title across roots and persists the immediate source", async () => {
  const db = getDatabase();
  // This prefix was historically reserved for default session titles.
  const base = "New session - 🌿Flow_%[a]";
  await createSession("main", "New session - 2026-11-11T00:00:00.000Z");
  writeTurn("main", base);
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
  writeTurn("main", "Question");
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
  db.exec(
    "CREATE TRIGGER block_copy BEFORE INSERT ON part BEGIN SELECT RAISE(ABORT, 'blocked part write'); END",
  );
  await expect(
    forkSession(db, { sessionId: "main" }, directory),
  ).rejects.toThrow("blocked part write");
  expect(counts()).toEqual(before);
});
