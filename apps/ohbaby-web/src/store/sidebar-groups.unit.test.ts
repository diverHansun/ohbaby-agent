import type { UiGlobalSession } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import type { WorkspaceScopeSummary } from "../api/daemon/wire.js";
import { createGlobalCatalogStore } from "./global-catalog.js";
import {
  countGroupRows,
  projectGroupKey,
  selectSidebarGroups,
} from "./sidebar-groups.js";

function session(
  id: string,
  projectDirectory: string | null,
  extra: Partial<UiGlobalSession> = {},
): UiGlobalSession {
  return {
    id,
    title: id,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    messageCount: 1,
    projectDirectory,
    workingDirectory: projectDirectory ?? "/default",
    ...extra,
  };
}

function scope(directory: string, available = true): WorkspaceScopeSummary {
  return { directory, available, lastOpenedAt: 0, loaded: false, position: 0 };
}

const none = new Map<string, never>();

describe("sidebar groups", () => {
  it("groups by projectDirectory only, keeps server project order and adds unknown projects", () => {
    const groups = selectSidebarGroups({
      projects: [scope("/b"), scope("/a", false)],
      sessions: [
        session("1", "/a"),
        session("2", null, { workingDirectory: "/b" }),
        session("3", "/new"),
        session("4", "/b"),
      ],
      pins: {},
      activity: none,
      extra: {},
      hasMore: false,
    });
    expect(groups.projects.map((group) => group.project)).toEqual([
      { directory: "/b", available: true },
      { directory: "/a", available: false },
      { directory: "/new", available: true },
    ]);
    expect(groups.projects[0]?.sessions.map((item) => item.id)).toEqual(["4"]);
    expect(groups.noProject?.sessions.map((item) => item.id)).toEqual(["2"]);
    expect(groups.pinned).toBeNull();
  });

  it("shows pinned rows only in Pinned, newest pin first", () => {
    const groups = selectSidebarGroups({
      projects: [scope("/a")],
      sessions: [session("1", "/a"), session("2", "/a"), session("3", null)],
      pins: { "1": 10, "3": 20 },
      activity: none,
      extra: {},
      hasMore: false,
    });
    expect(groups.pinned?.sessions.map((item) => item.id)).toEqual(["3", "1"]);
    expect(groups.projects[0]?.sessions.map((item) => item.id)).toEqual(["2"]);
    expect(groups.noProject).toBeNull();
  });

  it("pages 6 per group and 8 for Pinned, counts only loaded rows, and keeps an entry while pages remain", () => {
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session(`p${String(index)}`, "/a"),
    );
    const pins = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `x${String(index)}`,
        index + 1,
      ]),
    );
    const pinned = Array.from({ length: 10 }, (_, index) =>
      session(`x${String(index)}`, null),
    );
    const groups = selectSidebarGroups({
      projects: [scope("/a"), scope("/empty")],
      sessions: [...sessions, ...pinned],
      pins,
      activity: none,
      extra: { [projectGroupKey("/a")]: 20 },
      hasMore: true,
    });
    const a = groups.projects[0];
    const empty = groups.projects[1];
    expect(a.visible).toHaveLength(26);
    expect(a.hiddenLoaded).toBe(4);
    expect(a.canShowLess).toBe(true);
    expect(empty.visible).toHaveLength(0);
    expect(empty.canShowMore).toBe(true);
    expect(groups.pinned?.visible).toHaveLength(8);
    expect(groups.pinned?.hiddenLoaded).toBe(2);
    expect(groups.noProject?.sessions).toHaveLength(0);
    expect(groups.noProject?.canShowMore).toBe(true);
  });

  it("keeps Pinned visible before its rows are loaded, and hides it once pages are exhausted", () => {
    const input = {
      projects: [],
      sessions: [session("1", null)],
      pins: { archived: 1 },
      activity: none,
      extra: {},
    };
    expect(
      selectSidebarGroups({ ...input, hasMore: true }).pinned?.canShowMore,
    ).toBe(true);
    expect(selectSidebarGroups({ ...input, hasMore: false }).pinned).toBeNull();
  });

  it("uses the pending directory for requests and reports activity", () => {
    const groups = selectSidebarGroups({
      projects: [],
      sessions: [
        session("1", null, {
          workingDirectory: "/old",
          pendingWorkingDirectory: "/next",
        }),
      ],
      pins: {},
      activity: new Map([["1", "awaiting" as const]]),
      extra: {},
      hasMore: false,
    });
    expect(groups.noProject?.sessions[0]).toMatchObject({
      workingDirectory: "/old",
      requestDirectory: "/next",
      activity: "awaiting",
    });
  });
});

describe("global catalog store", () => {
  it("dedupes appended pages and keeps newest-first order on upsert", () => {
    const store = createGlobalCatalogStore();
    store.replaceSessions(
      [
        session("b", null, { updatedAt: "2026-10-02T00:00:00.000Z" }),
        session("a", null),
      ],
      "c1",
    );
    store.appendSessions([session("a", null), session("z", null)], undefined);
    expect(store.getSnapshot().sessions.map((value) => value.id)).toEqual([
      "b",
      "a",
      "z",
    ]);
    store.upsertSession(
      session("z", "/p", { updatedAt: "2026-10-03T00:00:00.000Z" }),
    );
    expect(store.getSnapshot().sessions.map((value) => value.id)).toEqual([
      "z",
      "b",
      "a",
    ]);
    expect(store.getSnapshot().nextCursor).toBeUndefined();
  });

  it("keeps old rows when a refresh fails", () => {
    const store = createGlobalCatalogStore();
    store.replaceSessions([session("a", null)], undefined);
    store.failSessions("offline");
    expect(store.getSnapshot()).toMatchObject({
      sessionsStatus: "error",
      sessionsError: "offline",
    });
    expect(store.getSnapshot().sessions).toHaveLength(1);
  });
});

describe("group row count", () => {
  it("counts loaded rows the way the groups place them", () => {
    const sessions = [
      session("1", "/a"),
      session("2", "/a"),
      session("3", null),
      session("4", "/a"),
    ];
    const pins = { "2": 1 };
    expect(countGroupRows(projectGroupKey("/a"), sessions, pins)).toBe(2);
    expect(countGroupRows("pinned", sessions, pins)).toBe(1);
    expect(countGroupRows("no-project", sessions, pins)).toBe(1);
  });
});
