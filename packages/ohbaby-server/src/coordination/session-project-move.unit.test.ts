import {
  SessionWorkspaceMoveError,
  type CoreSession,
  type SessionWorkspaceMovePlan,
} from "ohbaby-agent";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultWorkspaceNotProjectError,
  moveSessionProject,
  type GlobalSessionCatalog,
  type SessionProjectMoveDeps,
} from "./session-project-move.js";

function session(overrides: Partial<CoreSession> = {}): CoreSession {
  return {
    id: "s1",
    projectId: "global",
    workingDirectory: "/repo/a",
    workspaceDirectory: "/repo/a",
    title: "First",
    agentName: "default",
    createdAt: 0,
    updatedAt: 0,
    status: "active",
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: false,
    ...overrides,
  };
}

function plan(
  overrides: Partial<SessionWorkspaceMovePlan> = {},
): SessionWorkspaceMovePlan {
  return {
    sessionId: "s1",
    binding: {
      workspaceDirectory: "/repo/b",
      pendingWorkingDirectory: "/repo/b",
    },
    queueRoot: "/repo/b",
    needsQueueHandover: false,
    ...overrides,
  };
}

function createDeps(movePlan: SessionWorkspaceMovePlan): {
  readonly deps: SessionProjectMoveDeps;
  readonly planMove: ReturnType<typeof vi.fn>;
  readonly commitMove: ReturnType<typeof vi.fn>;
  readonly discoverProject: ReturnType<typeof vi.fn>;
  readonly loadQueueOwner: ReturnType<typeof vi.fn>;
  readonly adopt: ReturnType<typeof vi.fn>;
} {
  const planMove = vi.fn(() => movePlan);
  const commitMove = vi.fn(() =>
    Promise.resolve(session({ workspaceDirectory: "/repo/b" })),
  );
  const adopt = vi.fn(() => Promise.resolve());
  const discoverProject = vi.fn(() => Promise.resolve());
  const loadQueueOwner = vi.fn(() =>
    Promise.resolve({ adoptSessionWorkspaceMove: adopt }),
  );
  const catalog: GlobalSessionCatalog = {
    list: vi.fn(),
    search: vi.fn(),
    get: vi.fn(() => session({ pendingWorkingDirectory: "/repo/b" })),
    planMove,
    commitMove,
  };
  return {
    deps: {
      catalog,
      resolveScope: (directory) =>
        Promise.resolve(directory.replace(/\/sub$/u, "")),
      isDefaultWorkspace: (directory) =>
        directory === "/home/.ohbaby/workspace/default",
      discoverProject,
      loadQueueOwner,
    },
    planMove,
    commitMove,
    discoverProject,
    loadQueueOwner,
    adopt,
  };
}

describe("moveSessionProject", () => {
  it("resolves the project scope and writes the binding directly without queued prompts", async () => {
    const fixture = createDeps(plan());

    const moved = await moveSessionProject(fixture.deps, "s1", "/repo/b/sub");

    expect(fixture.planMove).toHaveBeenCalledWith("s1", "/repo/b");
    expect(fixture.discoverProject).toHaveBeenCalledWith("/repo/b");
    expect(fixture.commitMove).toHaveBeenCalledTimes(1);
    expect(fixture.loadQueueOwner).not.toHaveBeenCalled();
    expect(moved.workspaceDirectory).toBe("/repo/b");
  });

  it("lets the queue owner take the binding and its queued prompts", async () => {
    const handover = plan({ needsQueueHandover: true });
    const fixture = createDeps(handover);

    const moved = await moveSessionProject(fixture.deps, "s1", "/repo/b");

    expect(fixture.loadQueueOwner).toHaveBeenCalledWith("/repo/b");
    expect(fixture.adopt).toHaveBeenCalledWith(handover);
    expect(fixture.commitMove).not.toHaveBeenCalled();
    expect(moved.pendingWorkingDirectory).toBe("/repo/b");
  });

  it("leaves a project without resolving or registering a directory", async () => {
    const fixture = createDeps(plan({ binding: {}, queueRoot: "/repo/a" }));

    await moveSessionProject(fixture.deps, "s1", null);

    expect(fixture.planMove).toHaveBeenCalledWith("s1", null);
    expect(fixture.discoverProject).not.toHaveBeenCalled();
  });

  it("refuses the default workspace as a project", async () => {
    const fixture = createDeps(plan());

    await expect(
      moveSessionProject(fixture.deps, "s1", "/home/.ohbaby/workspace/default"),
    ).rejects.toBeInstanceOf(DefaultWorkspaceNotProjectError);
    expect(fixture.planMove).not.toHaveBeenCalled();
  });

  it("fails when the queue owner cannot take over prompts", async () => {
    const fixture = createDeps(plan({ needsQueueHandover: true }));
    fixture.loadQueueOwner.mockResolvedValue({});

    await expect(
      moveSessionProject(fixture.deps, "s1", "/repo/b"),
    ).rejects.toThrow("Workspace cannot take over queued prompts");
  });

  it("passes catalog errors through", async () => {
    const fixture = createDeps(plan());
    fixture.planMove.mockImplementation(() => {
      throw new SessionWorkspaceMoveError("SESSION_ARCHIVED", "archived");
    });

    await expect(
      moveSessionProject(fixture.deps, "s1", null),
    ).rejects.toMatchObject({
      code: "SESSION_ARCHIVED",
    });
  });
});
