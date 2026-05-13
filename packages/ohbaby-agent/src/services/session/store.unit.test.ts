import { describe, expect, it } from "vitest";
import { SessionNotFoundError } from "./errors.js";
import { createInMemorySessionStore } from "./store.js";
import type { Session } from "./types.js";

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

describe("createInMemorySessionStore", () => {
  it("stores cloned sessions instead of exposing mutable state", async () => {
    const store = createInMemorySessionStore();
    await store.insert(createSession());

    const session = await store.get("session_1");
    const writable = session as Session & { title: string };
    writable.title = "Mutated";

    await expect(store.get("session_1")).resolves.toMatchObject({
      title: "Session",
    });
  });

  it("lists project sessions and recent sessions by updated time", async () => {
    const store = createInMemorySessionStore();
    await store.insert(
      createSession({
        id: "old_active",
        projectId: "project_1",
        updatedAt: 1_000,
        status: "active",
      }),
    );
    await store.insert(
      createSession({
        id: "new_archived",
        projectId: "project_1",
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

    await expect(store.listByProject("project_1")).resolves.toMatchObject([
      { id: "new_archived" },
      { id: "old_active" },
    ]);
    await expect(
      store.listByProject("project_1", { status: "active", limit: 1 }),
    ).resolves.toMatchObject([{ id: "old_active" }]);
    await expect(store.getRecent(2)).resolves.toMatchObject([
      { id: "new_archived" },
      { id: "other_project" },
    ]);

    await store.insert(
      createSession({
        id: "child_1",
        projectId: "project_1",
        parentId: "old_active",
        updatedAt: 4_000,
      }),
    );
    await expect(store.listChildren("old_active")).resolves.toMatchObject([
      { id: "child_1" },
    ]);
  });

  it("rolls back in-memory writes when a transaction fails", async () => {
    const store = createInMemorySessionStore();

    await expect(
      store.withTransaction(async (transaction) => {
        await transaction.insert(createSession({ id: "session_rollback" }));
        await transaction.update("missing_session", { title: "Nope" });
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    await expect(store.get("session_rollback")).resolves.toBeNull();
  });
});
