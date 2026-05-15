import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseMessageStore } from "../../core/message/index.js";
import type { CoreMessage } from "../../core/message/index.js";
import { closeDatabase, initDatabase } from "../database/index.js";
import { DuplicateSessionError, SessionNotFoundError } from "./errors.js";
import { createDatabaseSessionStore } from "./database-store.js";
import type { Session, SessionStore } from "./types.js";

const cleanupPaths: string[] = [];

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    projectId: "project_1",
    projectRoot: "D:/repo",
    title: "Session",
    agentName: "default",
    createdAt: 1_000,
    updatedAt: 1_000,
    status: "active",
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: false,
    ...overrides,
  };
}

function userMessage(overrides: Partial<CoreMessage> = {}): CoreMessage {
  return {
    id: "message_1",
    sessionId: "session_1",
    role: "user",
    agent: "default",
    time: { created: 1_000 },
    ...overrides,
  } as CoreMessage;
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-session-db-"));
  cleanupPaths.push(directory);
  initDatabase({ dbPath: join(directory, "agent.db") });
});

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createDatabaseSessionStore", () => {
  it("persists and clones sessions", async () => {
    const store = createDatabaseSessionStore();
    await store.insert(createSession());

    const session = await store.get("session_1");
    const writable = session as Session & { title: string };
    writable.title = "Mutated";

    await expect(store.get("session_1")).resolves.toMatchObject({
      title: "Session",
      projectRoot: "D:/repo",
    });
  });

  it("rejects duplicate sessions and missing updates", async () => {
    const store = createDatabaseSessionStore();
    await store.insert(createSession());

    await expect(store.insert(createSession())).rejects.toBeInstanceOf(
      DuplicateSessionError,
    );
    await expect(
      store.update("missing", { title: "Nope" }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("keeps the original id when a patch includes an id", async () => {
    const store = createDatabaseSessionStore();
    await store.insert(createSession());

    await expect(
      store.update("session_1", { id: "renamed", title: "Updated" }),
    ).resolves.toMatchObject({ id: "session_1", title: "Updated" });
    await expect(store.get("session_1")).resolves.toMatchObject({
      id: "session_1",
      title: "Updated",
    });
    await expect(store.get("renamed")).resolves.toBeNull();
  });

  it("lists sessions by project, children, and recency", async () => {
    const store = createDatabaseSessionStore();
    await store.insert(
      createSession({ id: "old_active", updatedAt: 1_000, status: "active" }),
    );
    await store.insert(
      createSession({
        id: "new_archived",
        updatedAt: 3_000,
        status: "archived",
      }),
    );
    await store.insert(
      createSession({
        id: "other_project",
        projectId: "project_2",
        updatedAt: 2_000,
      }),
    );
    await store.insert(
      createSession({
        id: "child_1",
        parentId: "old_active",
        updatedAt: 4_000,
      }),
    );

    await expect(store.listByProject("project_1")).resolves.toMatchObject([
      { id: "child_1" },
      { id: "new_archived" },
      { id: "old_active" },
    ]);
    await expect(
      store.listByProject("project_1", { status: "active", limit: 1 }),
    ).resolves.toMatchObject([{ id: "child_1" }]);
    await expect(store.listChildren("old_active")).resolves.toMatchObject([
      { id: "child_1" },
    ]);
    await expect(store.getRecent(2)).resolves.toMatchObject([
      { id: "child_1" },
      { id: "new_archived" },
    ]);
  });

  it("rolls back transaction writes when an operation fails", async () => {
    const store = createDatabaseSessionStore();

    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.insert(createSession({ id: "rolled_back" }));
        await transaction.update("missing", { title: "Nope" });
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    await expect(store.get("rolled_back")).resolves.toBeNull();
  });

  it("rejects writes made outside the transaction store while active", async () => {
    const store = createDatabaseSessionStore();

    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.insert(createSession({ id: "rolled_back" }));
        await store.insert(createSession({ id: "outside_commit" }));
      }),
    ).rejects.toThrow(/transaction/i);

    await expect(store.get("rolled_back")).resolves.toBeNull();
    await expect(store.get("outside_commit")).resolves.toBeNull();
  });

  it("rejects a transaction store after the transaction closes", async () => {
    const store = createDatabaseSessionStore();
    let leakedStore: SessionStore | undefined;

    await store.withTransaction(async (transaction) => {
      leakedStore = transaction;
      await transaction.get("missing");
    });

    await expect(
      leakedStore?.insert(createSession({ id: "too_late" })),
    ).rejects.toThrow(/transaction/i);
    await expect(store.get("too_late")).resolves.toBeNull();
  });

  it("does not roll back other database stores sharing the same connection", async () => {
    const store = createDatabaseSessionStore();
    const messageStore = createDatabaseMessageStore();
    await store.insert(createSession());

    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.insert(createSession({ id: "rolled_back" }));
        await messageStore.insertMessage(userMessage());
        await transaction.update("missing", { title: "Nope" });
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    await expect(store.get("rolled_back")).resolves.toBeNull();
    await expect(messageStore.getMessage("message_1")).resolves.toMatchObject({
      id: "message_1",
      sessionId: "session_1",
    });
  });
});
