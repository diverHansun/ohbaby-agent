import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeSubagentSessionManager,
  InMemorySubagentSessionManager,
  PersistentSubagentSessionManager,
} from "./session-manager.js";
import type { Session } from "../services/session/index.js";

function persistentSession(
  input: Partial<Session> &
    Pick<Session, "agentName" | "id" | "isSubagent" | "projectRoot">,
): Session {
  return {
    childrenIds: input.childrenIds ?? [],
    createdAt: input.createdAt ?? 1,
    id: input.id,
    agentName: input.agentName,
    isSubagent: input.isSubagent,
    projectId: input.projectId ?? "project",
    projectRoot: input.projectRoot,
    stats: input.stats ?? { messageCount: 0 },
    status: input.status ?? "active",
    title: input.title ?? "Session",
    updatedAt: input.updatedAt ?? 1,
    parentId: input.parentId,
  };
}

describe("InMemorySubagentSessionManager", () => {
  it("ensures primary roots and preserves existing child links", async () => {
    const manager = new InMemorySubagentSessionManager();

    await manager.ensureRoot({
      agentName: "build",
      id: "parent",
      projectRoot: "D:/repo",
      title: "Parent",
    });
    const child = await manager.create("D:/other", {
      agentName: "explore",
      parentId: "parent",
      title: "Explore",
    });
    await manager.ensureRoot({
      agentName: "build",
      id: "parent",
      projectRoot: "D:/repo",
      title: "Parent renamed",
    });

    await expect(manager.get("parent")).resolves.toMatchObject({
      agentName: "build",
      childrenIds: [child.id],
      id: "parent",
      isSubagent: false,
      projectRoot: "D:/repo",
    });
  });

  it("creates child sessions that inherit the parent project root", async () => {
    const manager = new InMemorySubagentSessionManager();
    await manager.ensureRoot({
      agentName: "build",
      id: "parent",
      projectRoot: "D:/repo",
      title: "Parent",
    });

    const child = await manager.create("D:/ignored", {
      agentName: "research",
      parentId: "parent",
    });

    expect(child).toMatchObject({
      agentName: "research",
      isSubagent: true,
      parentId: "parent",
      projectRoot: "D:/repo",
    });
    await expect(manager.get("parent")).resolves.toMatchObject({
      childrenIds: [child.id],
    });
  });
});

describe("PersistentSubagentSessionManager", () => {
  it("does not recreate an existing root session", async () => {
    const existing = persistentSession({
      agentName: "build",
      childrenIds: [],
      id: "parent",
      isSubagent: false,
      projectRoot: "D:/repo",
    });
    const create = vi.fn(() => Promise.resolve(existing));
    const get = vi.fn(() => Promise.resolve(existing));
    const manager = new PersistentSubagentSessionManager({ create, get });

    await manager.ensureRoot({
      agentName: "build",
      id: "parent",
      projectRoot: "D:/repo",
      title: "Parent",
    });

    expect(create).not.toHaveBeenCalled();
  });

  it("creates missing roots and delegates child creation", async () => {
    const created = persistentSession({
      agentName: "build",
      childrenIds: [],
      id: "parent",
      isSubagent: false,
      projectRoot: "D:/repo",
    });
    const child = persistentSession({
      agentName: "explore",
      childrenIds: [],
      id: "child",
      isSubagent: true,
      parentId: "parent",
      projectRoot: "D:/repo",
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(child);
    const get = vi.fn(() => Promise.resolve(null));
    const manager = new PersistentSubagentSessionManager({ create, get });

    await manager.ensureRoot({
      agentName: "build",
      id: "parent",
      projectRoot: "D:/repo",
      title: "Parent",
    });
    await expect(
      manager.create("D:/repo", {
        agentName: "explore",
        parentId: "parent",
      }),
    ).resolves.toBe(child);

    expect(create).toHaveBeenNthCalledWith(1, "D:/repo", {
      agentName: "build",
      id: "parent",
      title: "Parent",
    });
    expect(create).toHaveBeenNthCalledWith(2, "D:/repo", {
      agentName: "explore",
      parentId: "parent",
    });
  });
});

describe("createRuntimeSubagentSessionManager", () => {
  it("uses a persistent adapter only when a backing manager is provided", () => {
    expect(createRuntimeSubagentSessionManager()).toBeInstanceOf(
      InMemorySubagentSessionManager,
    );
    expect(
      createRuntimeSubagentSessionManager({
        create: vi.fn(),
        get: vi.fn(),
      }),
    ).toBeInstanceOf(PersistentSubagentSessionManager);
  });
});
