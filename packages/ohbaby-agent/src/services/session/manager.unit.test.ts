import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { SessionEvent } from "./index.js";
import { createSessionManager } from "./manager.js";
import { createInMemorySessionStore } from "./store.js";
import type {
  MessageCleaner,
  ProjectInfo,
  ProjectResolver,
  Session,
  SessionManager,
  SessionStore,
} from "./types.js";

interface ManagerFixture {
  readonly manager: SessionManager;
  readonly createdEvents: readonly Session[];
  readonly removedEvents: readonly string[];
  readonly updatedEvents: readonly Session[];
}

function createClock(startAt = 1_000): () => number {
  let current = startAt;

  return () => {
    const value = current;
    current += 1_000;
    return value;
  };
}

function createProjectResolver(): ProjectResolver {
  return {
    fromDirectory(directory: string): Promise<ProjectInfo> {
      return Promise.resolve({
        id: `project:${directory}`,
        rootPath: `root:${directory}`,
      });
    },
  };
}

function createDeterministicIds(): () => string {
  let next = 1;

  return () => {
    const id = `session_test_${String(next)}`;
    next += 1;
    return id;
  };
}

const NOOP_MESSAGE_CLEANER: MessageCleaner = {
  removeMessages(): Promise<void> {
    return Promise.resolve();
  },
};

function createManager(
  options: {
    readonly store?: SessionStore;
    readonly projectResolver?: ProjectResolver;
    readonly messageCleaner?: MessageCleaner;
    readonly now?: () => number;
  } = {},
): ManagerFixture {
  const bus = createBus();
  const createdEvents: Session[] = [];
  const removedEvents: string[] = [];
  const updatedEvents: Session[] = [];
  bus.subscribe(SessionEvent.Created, (payload) => {
    createdEvents.push(payload.session);
  });
  bus.subscribe(SessionEvent.Updated, (payload) => {
    updatedEvents.push(payload.session);
  });
  bus.subscribe(SessionEvent.Removed, (payload) => {
    removedEvents.push(payload.sessionId);
  });
  const manager = createSessionManager({
    bus,
    store: options.store ?? createInMemorySessionStore(),
    projectResolver: options.projectResolver ?? createProjectResolver(),
    messageCleaner: options.messageCleaner ?? NOOP_MESSAGE_CLEANER,
    createSessionId: createDeterministicIds(),
    now: options.now ?? createClock(),
  });

  return { manager, createdEvents, removedEvents, updatedEvents };
}

class RejectingInsertStore implements SessionStore {
  private readonly inner = createInMemorySessionStore();

  insert(): Promise<void> {
    return Promise.reject(new Error("insert failed"));
  }

  get(sessionId: string): Promise<Session | null> {
    return this.inner.get(sessionId);
  }

  listByProject(
    projectId: string,
    options?: Parameters<SessionStore["listByProject"]>[1],
  ): Promise<Session[]> {
    return this.inner.listByProject(projectId, options);
  }

  listChildren(
    parentId: string,
    options?: Parameters<SessionStore["listChildren"]>[1],
  ): Promise<Session[]> {
    return this.inner.listChildren(parentId, options);
  }

  getRecent(limit: number): Promise<Session[]> {
    return this.inner.getRecent(limit);
  }

  update(
    sessionId: string,
    patch: Parameters<SessionStore["update"]>[1],
  ): Promise<Session> {
    return this.inner.update(sessionId, patch);
  }

  remove(sessionId: string): Promise<void> {
    return this.inner.remove(sessionId);
  }

  withTransaction<T>(
    operation: (store: SessionStore) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}

describe("SessionManager", () => {
  it("creates a project-scoped session and publishes Created after persistence", async () => {
    const { manager, createdEvents } = createManager();

    const session = await manager.create("D:/repo", {
      title: "Implement daemon",
      agentName: "coder",
    });

    expect(session).toEqual({
      id: "session_test_1",
      projectId: "project:D:/repo",
      projectRoot: "root:D:/repo",
      title: "Implement daemon",
      agentName: "coder",
      createdAt: 1_000,
      updatedAt: 1_000,
      status: "active",
      stats: { messageCount: 0 },
      childrenIds: [],
      isSubagent: false,
    });
    await expect(manager.get(session.id)).resolves.toEqual(session);
    expect(createdEvents).toEqual([session]);
  });

  it("does not publish Created when persistence fails", async () => {
    const { manager, createdEvents } = createManager({
      store: new RejectingInsertStore(),
    });

    await expect(manager.create("D:/repo")).rejects.toThrow("insert failed");

    expect(createdEvents).toEqual([]);
  });

  it("ensureRoot creates a project-scoped root session with the requested id", async () => {
    const { manager, createdEvents } = createManager();

    const session = await manager.ensureRoot({
      agentName: "build",
      id: "root_session",
      projectRoot: "D:/repo",
      title: "Root",
    });

    expect(session).toEqual({
      id: "root_session",
      projectId: "project:D:/repo",
      projectRoot: "root:D:/repo",
      title: "Root",
      agentName: "build",
      createdAt: 1_000,
      updatedAt: 1_000,
      status: "active",
      stats: { messageCount: 0 },
      childrenIds: [],
      isSubagent: false,
    });
    await expect(manager.get("root_session")).resolves.toEqual(session);
    expect(createdEvents).toEqual([session]);
  });

  it("ensureRoot returns an existing session without mutating fields or publishing Created", async () => {
    const { manager, createdEvents } = createManager();
    const existing = await manager.create("D:/repo", {
      agentName: "build",
      id: "root_session",
      title: "Original",
    });
    const createdEventCount = createdEvents.length;

    const session = await manager.ensureRoot({
      agentName: "research",
      id: "root_session",
      projectRoot: "D:/other",
      title: "Changed",
    });

    expect(session).toEqual(existing);
    await expect(manager.get("root_session")).resolves.toEqual(existing);
    expect(createdEvents).toHaveLength(createdEventCount);
  });

  it("creates child sessions under the parent project and records children on the parent", async () => {
    const { manager, removedEvents, updatedEvents } = createManager();
    const parent = await manager.create("D:/parent", {
      title: "Parent",
    });

    const child = await manager.create("D:/ignored", {
      parentId: parent.id,
      title: "Explore",
      agentName: "explorer",
    });

    expect(child).toMatchObject({
      id: "session_test_2",
      projectId: parent.projectId,
      projectRoot: parent.projectRoot,
      parentId: parent.id,
      title: "Explore",
      agentName: "explorer",
      isSubagent: true,
    });
    await expect(manager.get(parent.id)).resolves.toMatchObject({
      childrenIds: [child.id],
      updatedAt: 3_000,
    });
    await expect(manager.listChildren(parent.id)).resolves.toEqual([child]);

    await manager.remove(child.id);
    await expect(manager.listChildren(parent.id)).resolves.toEqual([]);
    await expect(manager.get(parent.id)).resolves.toMatchObject({
      childrenIds: [],
      updatedAt: 4_000,
    });
    expect(updatedEvents.map((event) => event.id)).toEqual([
      parent.id,
      parent.id,
    ]);
    expect(removedEvents).toEqual([child.id]);
  });

  it("finds a reusable empty primary session within the same project only", async () => {
    const { manager } = createManager();
    const filled = await manager.create("D:/repo", {
      title: "Filled",
    });
    await manager.incrementStats(filled.id, {
      lastMessageAt: 1_500,
      messageCountDelta: 1,
    });
    const empty = await manager.create("D:/repo", {
      title: "Reusable",
    });
    await manager.create("D:/other", {
      title: "Other project",
    });
    await manager.create("D:/ignored", {
      parentId: filled.id,
      title: "Child empty",
    });

    await expect(manager.findReusableEmptyPrimary("D:/repo")).resolves.toEqual(
      empty,
    );
    await expect(
      manager.findReusableEmptyPrimary("D:/missing"),
    ).resolves.toBeNull();
  });

  it("updates metadata and increments stats without touching immutable fields", async () => {
    const { manager, updatedEvents } = createManager();
    const session = await manager.create("D:/repo");

    await expect(
      manager.update(session.id, {
        title: "Renamed",
        status: "archived",
      }),
    ).resolves.toMatchObject({
      id: session.id,
      projectId: session.projectId,
      title: "Renamed",
      status: "archived",
      updatedAt: 2_000,
    });

    await expect(
      manager.incrementStats(session.id, { messageCountDelta: 2 }),
    ).resolves.toMatchObject({
      stats: { messageCount: 2, lastMessageAt: 3_000 },
      updatedAt: 3_000,
      createdAt: 1_000,
    });
    expect(updatedEvents.map((event) => event.updatedAt)).toEqual([
      2_000, 3_000,
    ]);
  });

  it("removes messages before deleting the session and keeps metadata when cleanup fails", async () => {
    const cleaned: string[] = [];
    const { manager, removedEvents } = createManager({
      messageCleaner: {
        removeMessages(sessionId: string): Promise<void> {
          cleaned.push(sessionId);
          if (sessionId === "session_test_2") {
            return Promise.reject(new Error("message cleanup failed"));
          }
          return Promise.resolve();
        },
      },
    });
    const removable = await manager.create("D:/repo", { title: "Remove me" });
    const retained = await manager.create("D:/repo", { title: "Keep me" });

    await manager.remove(removable.id);
    await expect(manager.get(removable.id)).resolves.toBeNull();
    expect(removedEvents).toEqual([removable.id]);

    await expect(manager.remove(retained.id)).rejects.toThrow(
      "message cleanup failed",
    );
    await expect(manager.get(retained.id)).resolves.toMatchObject({
      id: retained.id,
    });
    expect(cleaned).toEqual([removable.id, retained.id]);
  });
});
