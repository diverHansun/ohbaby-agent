import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { INITIAL_MIGRATIONS } from "../../services/database/migrations.js";
import { createDatabaseSessionStore } from "../../services/session/database-store.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";

let dir: string | undefined;
afterEach(async () => {
  closeDatabase();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(["memory", "sqlite"])(
  "%s persists the submitted model across editing and reopening",
  async (kind) => {
    dir = await mkdtemp(join(tmpdir(), "model-submission-"));
    const dbPath = join(dir, "data.db");
    initDatabase({ dbPath });
    getDatabase()
      .prepare(
        "INSERT INTO session (id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
      )
      .run();
    const store =
      kind === "memory"
        ? new InMemoryPromptSubmissionStore()
        : new DatabasePromptSubmissionStore();
    const input = {
      clientRequestId: "req",
      promptId: "p",
      scopeKey: "/work",
      sessionId: "s",
      userMessageId: "u",
      text: "hello",
      maxQueuedPrompts: 100,
      modelEntryId: "model-a",
    };
    await store.accept(input);
    expect((await store.get("p"))?.modelEntryId).toBe("model-a");
    await expect(
      store.accept({ ...input, modelEntryId: "model-b" }),
    ).rejects.toThrow(/conflict|different/i);
    expect((await store.accept(input)).inserted).toBe(false);
    const lease = await store.acquireEditLease("p", "client", 1000);
    expect(
      (await store.commitEdit("p", lease.editLeaseId, "edited")).modelEntryId,
    ).toBe("model-a");
    if (kind === "sqlite") {
      closeDatabase();
      initDatabase({ dbPath });
      expect(
        (await new DatabasePromptSubmissionStore().get("p"))?.modelEntryId,
      ).toBe("model-a");
    }
  },
);

it("persists session model and conditional removal cannot overwrite a newer choice", async () => {
  dir = await mkdtemp(join(tmpdir(), "model-session-"));
  const dbPath = join(dir, "data.db");
  initDatabase({ dbPath });
  getDatabase()
    .prepare(
      "INSERT INTO session (id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
    )
    .run();
  await createDatabaseSessionStore().update("s", { modelEntryId: "model-a" });
  closeDatabase();
  initDatabase({ dbPath });
  const store = createDatabaseSessionStore();
  expect((await store.get("s"))?.modelEntryId).toBe("model-a");
  await store.update("s", { modelEntryId: "model-b" });
  await store.update(
    "s",
    { modelEntryId: undefined },
    { expectedModelEntryId: "model-a" },
  );
  expect((await store.get("s"))?.modelEntryId).toBe("model-b");
  await store.update(
    "s",
    { modelEntryId: undefined },
    { expectedModelEntryId: "model-b" },
  );
  expect((await store.get("s"))?.modelEntryId).toBeUndefined();
});

it("migrates older queued submissions to follow the default model", async () => {
  dir = await mkdtemp(join(tmpdir(), "model-migration-"));
  const dbPath = join(dir, "data.db");
  initDatabase({
    dbPath,
    migrations: INITIAL_MIGRATIONS.filter(
      (migration) => migration.version < "027_prompt_submission_model_entry",
    ),
  });
  getDatabase()
    .prepare(
      "INSERT INTO session (id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES ('s','p','/work','t','active',1,1,'{}')",
    )
    .run();
  getDatabase()
    .prepare(
      "INSERT INTO prompt_submission (prompt_id,client_request_id,scope_key,session_id,user_message_id,text,status,created_at,updated_at,accepted_at,admission_order) VALUES ('p','request','/work','s','u','legacy','queued',1,1,1,1)",
    )
    .run();
  closeDatabase();
  initDatabase({ dbPath });
  expect(
    (await new DatabasePromptSubmissionStore().get("p"))?.modelEntryId,
  ).toBeUndefined();
  expect(
    getDatabase()
      .prepare<{ name: string }>("PRAGMA table_info(prompt_submission)")
      .all()
      .map((column) => column.name),
  ).toContain("model_entry_id");
});
