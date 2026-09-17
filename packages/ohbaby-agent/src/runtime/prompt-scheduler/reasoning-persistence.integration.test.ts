import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import { createDatabaseSessionStore } from "../../services/session/database-store.js";
let dir: string | undefined;
afterEach(async () => {
  closeDatabase();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it.each(["memory", "sqlite"])(
  "%s keeps immutable reasoning through replay, editing and reopen",
  async (kind) => {
    dir = await mkdtemp(join(tmpdir(), "reasoning-store-"));
    const path = join(dir, "data.db");
    initDatabase({ dbPath: path });
    getDatabase()
      .prepare(
        "INSERT INTO session (id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
      )
      .run();
    const store =
      kind === "memory"
        ? new InMemoryPromptSubmissionStore()
        : new DatabasePromptSubmissionStore();
    const reasoning = { effort: "medium" };
    const input = {
      clientRequestId: "req",
      promptId: "p",
      scopeKey: "/work",
      sessionId: "s",
      userMessageId: "u",
      text: "hi",
      maxQueuedPrompts: 100,
      reasoning,
    };
    await store.accept(input);
    reasoning.effort = "high";
    expect((await store.get("p"))?.reasoning).toEqual({ effort: "medium" });
    await expect(
      store.accept({ ...input, reasoning: { effort: "high" } }),
    ).rejects.toThrow(/conflict|different/i);
    expect(
      (await store.accept({ ...input, reasoning: { effort: "medium" } }))
        .inserted,
    ).toBe(false);
    const lease = await store.acquireEditLease("p", "client", 1000);
    expect(
      (await store.commitEdit("p", lease.editLeaseId, "edited")).reasoning,
    ).toEqual({ effort: "medium" });
    if (kind === "sqlite") {
      closeDatabase();
      initDatabase({ dbPath: path });
      expect(
        (await new DatabasePromptSubmissionStore().get("p"))?.reasoning,
      ).toEqual({ effort: "medium" });
    }
  },
);
it("existing session metadata persists independent preferences and supports clear", async () => {
  dir = await mkdtemp(join(tmpdir(), "reasoning-session-"));
  const path = join(dir, "data.db");
  initDatabase({ dbPath: path });
  const store = createDatabaseSessionStore();
  for (const [id, effort] of [
    ["a", "medium"],
    ["b", "high"],
  ])
    await store.insert({
      id,
      projectId: "p",
      projectRoot: "/work",
      title: "t",
      agentName: "default",
      createdAt: 1,
      updatedAt: 1,
      status: "active",
      stats: { messageCount: 0 },
      childrenIds: [],
      isSubagent: false,
      reasoning: { effort },
    });
  closeDatabase();
  initDatabase({ dbPath: path });
  const reopened = createDatabaseSessionStore();
  expect((await reopened.get("a"))?.reasoning).toEqual({ effort: "medium" });
  expect((await reopened.get("b"))?.reasoning).toEqual({ effort: "high" });
  await reopened.update("a", { reasoning: undefined });
  expect((await reopened.get("a"))?.reasoning).toBeUndefined();
});
it("migrates pre-reasoning submissions and reads legacy sessions without preferences", async () => {
  const { INITIAL_MIGRATIONS } =
    await import("../../services/database/migrations.js");
  dir = await mkdtemp(join(tmpdir(), "reasoning-legacy-"));
  const path = join(dir, "legacy.db");
  initDatabase({
    dbPath: path,
    migrations: INITIAL_MIGRATIONS.filter(
      (migration) => migration.version !== "016_prompt_submission_reasoning",
    ),
  });
  getDatabase()
    .prepare(
      "INSERT INTO session (id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
    )
    .run();
  getDatabase()
    .prepare(
      "INSERT INTO prompt_submission (prompt_id,client_request_id,scope_key,session_id,user_message_id,text,status,created_at,updated_at) VALUES ('p','request','/work','s','u','legacy','queued',1,1)",
    )
    .run();
  closeDatabase();
  initDatabase({ dbPath: path });
  expect(await new DatabasePromptSubmissionStore().get("p")).toMatchObject({
    text: "legacy",
    reasoning: undefined,
    status: "queued",
  });
  expect(
    (await createDatabaseSessionStore().get("s"))?.reasoning,
  ).toBeUndefined();
});
