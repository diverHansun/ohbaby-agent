import type { CoreSession } from "ohbaby-agent";
import { describe, expect, it } from "vitest";
import {
  globalSessionErrorStatus,
  parseGlobalSessionLimit,
  parseSessionWorkspaceUpdate,
  toUiGlobalSession,
} from "./global-sessions.js";

const session: CoreSession = {
  id: "s1",
  projectId: "global",
  workingDirectory: "/repo/a",
  pendingWorkingDirectory: "/repo/b",
  workspaceDirectory: "/repo/b",
  title: "First",
  agentName: "default",
  createdAt: 0,
  updatedAt: 1_000,
  status: "active",
  stats: { messageCount: 2 },
  childrenIds: [],
  isSubagent: false,
};

describe("global session wire format", () => {
  it("separates the project from the working directories", () => {
    expect(toUiGlobalSession(session)).not.toHaveProperty("projectDirectory");
    expect(toUiGlobalSession(session)).toEqual({
      id: "s1",
      title: "First",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      messageCount: 2,
      workspaceDirectory: "/repo/b",
      workingDirectory: "/repo/a",
      pendingWorkingDirectory: "/repo/b",
    });
    expect(
      toUiGlobalSession({
        ...session,
        workspaceDirectory: undefined,
        pendingWorkingDirectory: undefined,
      }),
    ).toMatchObject({ workspaceDirectory: null, workingDirectory: "/repo/a" });
  });

  it("parses page sizes", () => {
    expect(parseGlobalSessionLimit(undefined)).toBeUndefined();
    expect(parseGlobalSessionLimit("20")).toBe(20);
    for (const invalid of ["0", "-1", "1.5", "many"]) {
      expect(() => parseGlobalSessionLimit(invalid)).toThrow(
        "limit must be a positive integer",
      );
    }
  });

  it("requires a directory or an explicit null", () => {
    expect(parseSessionWorkspaceUpdate({ workspaceDirectory: "/repo" })).toBe(
      "/repo",
    );
    expect(
      parseSessionWorkspaceUpdate({ workspaceDirectory: null }),
    ).toBeNull();
    for (const invalid of [
      {},
      { projectDirectory: "/repo" },
      { workspaceDirectory: "" },
      { workspaceDirectory: 1 },
      null,
    ]) {
      expect(() => parseSessionWorkspaceUpdate(invalid)).toThrow(
        "workspaceDirectory must be a directory path or null",
      );
    }
  });

  it("maps failures to HTTP status", () => {
    const failure = (code: string): unknown => ({ code });
    expect(globalSessionErrorStatus(failure("INVALID_CURSOR"))).toBe(400);
    expect(globalSessionErrorStatus(failure("directory-unavailable"))).toBe(
      400,
    );
    expect(
      globalSessionErrorStatus(failure("DEFAULT_DIRECTORY_NOT_WORKSPACE")),
    ).toBe(400);
    expect(globalSessionErrorStatus(failure("SESSION_NOT_FOUND"))).toBe(404);
    expect(globalSessionErrorStatus(failure("SESSION_ARCHIVED"))).toBe(409);
    expect(globalSessionErrorStatus(new Error("boom"))).toBe(500);
  });
});
