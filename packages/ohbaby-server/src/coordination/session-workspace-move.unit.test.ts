import {
  SessionWorkspaceMoveError,
  type CoreSession,
  type SessionWorkspaceMovePlan,
} from "ohbaby-agent";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultDirectoryNotWorkspaceError,
  moveSessionWorkspace,
  type GlobalSessionCatalog,
  type SessionWorkspaceMoveDeps,
} from "./session-workspace-move.js";

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
  readonly deps: SessionWorkspaceMoveDeps;
  readonly planMove: ReturnType<typeof vi.fn>;
  readonly commitMove: ReturnType<typeof vi.fn>;
  readonly discoverWorkspace: ReturnType<typeof vi.fn>;
  readonly loadQueueOwner: ReturnType<typeof vi.fn>;
  readonly adopt: ReturnType<typeof vi.fn>;
} {
  const planMove = vi.fn(() => movePlan);
  const commitMove = vi.fn(() =>
    Promise.resolve(session({ workspaceDirectory: "/repo/b" })),
  );
  const adopt = vi.fn(() => Promise.resolve());
  const discoverWorkspace = vi.fn(() => Promise.resolve());
  const loadQueueOwner = vi.fn(() =>
    Promise.resolve({ adoptSessionWorkspaceMove: adopt }),
  );
  const catalog: GlobalSessionCatalog = {
    restore: vi.fn(),
    delete: vi.fn(),
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
      isDefaultDirectory: (directory) =>
        directory === "/home/.ohbaby/workspace/default",
      defaultDirectory: () =>
        Promise.resolve("/home/.ohbaby/workspace/default"),
      discoverWorkspace,
      loadQueueOwner,
    },
    planMove,
    commitMove,
    discoverWorkspace,
    loadQueueOwner,
    adopt,
  };
}

describe("moveSessionWorkspace", () => {
  it("resolves the project scope and writes the binding directly without queued prompts", async () => {
    const fixture = createDeps(plan());

    const moved = await moveSessionWorkspace(fixture.deps, "s1", "/repo/b/sub");

    expect(fixture.planMove).toHaveBeenCalledWith("s1", "/repo/b", undefined);
    expect(fixture.discoverWorkspace).toHaveBeenCalledWith("/repo/b");
    expect(fixture.commitMove).toHaveBeenCalledTimes(1);
    expect(fixture.loadQueueOwner).not.toHaveBeenCalled();
    expect(moved.workspaceDirectory).toBe("/repo/b");
  });

  it("lets the queue owner take the binding and its queued prompts", async () => {
    const handover = plan({ needsQueueHandover: true });
    const fixture = createDeps(handover);

    const moved = await moveSessionWorkspace(fixture.deps, "s1", "/repo/b");

    expect(fixture.loadQueueOwner).toHaveBeenCalledWith("/repo/b");
    expect(fixture.adopt).toHaveBeenCalledWith(handover);
    expect(fixture.commitMove).not.toHaveBeenCalled();
    expect(moved.pendingWorkingDirectory).toBe("/repo/b");
  });

  it("leaves a project without registering a directory", async () => {
    const fixture = createDeps(plan({ binding: {}, queueRoot: "/repo/a" }));

    await moveSessionWorkspace(fixture.deps, "s1", null);

    expect(fixture.planMove).toHaveBeenCalledWith("s1", null, undefined);
    expect(fixture.discoverWorkspace).not.toHaveBeenCalled();
  });

  it("runs a chat leaving its project in the default directory once its own is gone", async () => {
    const fixture = createDeps(plan({ binding: {}, queueRoot: "/repo/a" }));
    const deps: SessionWorkspaceMoveDeps = {
      ...fixture.deps,
      resolveScope: (directory) =>
        directory === "/repo/a"
          ? Promise.reject(new Error("missing"))
          : Promise.resolve(directory),
    };

    await moveSessionWorkspace(deps, "s1", null);

    expect(fixture.planMove).toHaveBeenCalledWith(
      "s1",
      null,
      "/home/.ohbaby/workspace/default",
    );
  });

  it("checks the updated working directory when a turn starts during removal", async () => {
    const fixture = createDeps(plan({ binding: {}, queueRoot: "/repo/b" }));
    let workingDirectory = "/repo/a";
    const resolveScope = vi.fn((directory: string) => {
      if (directory !== "/repo/a") return Promise.resolve(directory);
      workingDirectory = "/repo/b";
      return Promise.reject(new Error("missing"));
    });
    const deps: SessionWorkspaceMoveDeps = {
      ...fixture.deps,
      catalog: {
        ...fixture.deps.catalog,
        get: () => session({ workingDirectory }),
      },
      resolveScope,
    };

    await moveSessionWorkspace(deps, "s1", null);

    expect(resolveScope.mock.calls).toEqual([["/repo/a"], ["/repo/b"]]);
    expect(fixture.planMove).toHaveBeenCalledWith("s1", null, undefined);
  });

  it("refuses the default workspace as a project", async () => {
    const fixture = createDeps(plan());

    await expect(
      moveSessionWorkspace(
        fixture.deps,
        "s1",
        "/home/.ohbaby/workspace/default",
      ),
    ).rejects.toBeInstanceOf(DefaultDirectoryNotWorkspaceError);
    expect(fixture.planMove).not.toHaveBeenCalled();
  });

  it("fails when the queue owner cannot take over prompts", async () => {
    const fixture = createDeps(plan({ needsQueueHandover: true }));
    fixture.loadQueueOwner.mockResolvedValue({});

    await expect(
      moveSessionWorkspace(fixture.deps, "s1", "/repo/b"),
    ).rejects.toThrow("Workspace cannot take over queued prompts");
  });

  it("passes catalog errors through", async () => {
    const fixture = createDeps(plan());
    fixture.planMove.mockImplementation(() => {
      throw new SessionWorkspaceMoveError("SESSION_ARCHIVED", "archived");
    });

    await expect(
      moveSessionWorkspace(fixture.deps, "s1", null),
    ).rejects.toMatchObject({
      code: "SESSION_ARCHIVED",
    });
  });
});
