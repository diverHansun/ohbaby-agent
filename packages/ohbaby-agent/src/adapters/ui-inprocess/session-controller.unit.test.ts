import { describe, expect, it } from "vitest";
import type { UiSession, UiSnapshot } from "ohbaby-sdk";
import type { Session as CoreSession } from "../../services/session/index.js";
import {
  resolveSessionForNewPrompt,
  type InProcessSessionManager,
} from "./session-controller.js";

const BASE_TIME = "2026-05-20T00:00:00.000Z";

function uiSession(input: {
  readonly id: string;
  readonly messages?: UiSession["messages"];
  readonly projectRoot?: string;
  readonly title?: string;
}): UiSession {
  return {
    createdAt: BASE_TIME,
    id: input.id,
    messages: input.messages ?? [],
    projectRoot: input.projectRoot ?? "D:/repo",
    title: input.title ?? "New session",
    updatedAt: BASE_TIME,
  };
}

function coreSession(input: {
  readonly id: string;
  readonly isSubagent?: boolean;
  readonly messageCount?: number;
  readonly projectRoot?: string;
  readonly title?: string;
}): CoreSession {
  return {
    agentName: "default",
    childrenIds: [],
    createdAt: 1_000,
    id: input.id,
    isSubagent: input.isSubagent ?? false,
    projectId: "project_repo",
    projectRoot: input.projectRoot ?? "D:/repo",
    stats: { messageCount: input.messageCount ?? 0 },
    status: "active",
    title: input.title ?? "New session",
    updatedAt: 1_000,
  };
}

function snapshot(input: {
  readonly activeSessionId?: string | null;
  readonly sessions?: UiSession[];
}): UiSnapshot {
  return {
    activeSessionId: input.activeSessionId ?? null,
    permissions: [],
    runs: [],
    sessions: input.sessions ?? [],
    status: { kind: "idle" },
  };
}

function createResolver(input: {
  readonly isAuthoritativelyEmpty?: (id: string) => Promise<boolean>;
  readonly reuseInactiveEmptySessions?: boolean;
  readonly snapshot: UiSnapshot;
  readonly sessionManager?: InProcessSessionManager;
}): ReturnType<typeof resolveSessionForNewPrompt> {
  return resolveSessionForNewPrompt({
    createSession: (id) =>
      Promise.resolve(uiSession({ id: id ?? "session_created" })),
    getUiSession: (id) =>
      Promise.resolve(
        input.snapshot.sessions.find((session) => session.id === id) ?? null,
      ),
    projectRoot: "D:/repo",
    isAuthoritativelyEmpty: input.isAuthoritativelyEmpty,
    reuseInactiveEmptySessions: input.reuseInactiveEmptySessions,
    sessionManager: input.sessionManager,
    snapshot: input.snapshot,
  });
}

describe("resolveSessionForNewPrompt", () => {
  it("reuses the active empty UI session for the same project", async () => {
    const active = uiSession({ id: "session_active_empty" });

    await expect(
      createResolver({
        snapshot: snapshot({
          activeSessionId: active.id,
          sessions: [active],
        }),
      }),
    ).resolves.toMatchObject({
      isNewSession: false,
      session: { id: active.id },
    });
  });

  it("skips the active empty UI session when empty reuse is disabled", async () => {
    const active = uiSession({ id: "session_active_empty" });

    await expect(
      createResolver({
        reuseInactiveEmptySessions: false,
        snapshot: snapshot({
          activeSessionId: active.id,
          sessions: [active],
        }),
      }),
    ).resolves.toMatchObject({
      isNewSession: true,
      session: { id: "session_created" },
    });
  });

  it("skips a non-empty active session and creates a new session", async () => {
    const active = uiSession({
      id: "session_active_non_empty",
      messages: [
        {
          createdAt: BASE_TIME,
          id: "message_1",
          parts: [{ text: "Existing", type: "text" }],
          role: "user",
        },
      ],
    });

    await expect(
      createResolver({
        snapshot: snapshot({
          activeSessionId: active.id,
          sessions: [active],
        }),
      }),
    ).resolves.toMatchObject({
      isNewSession: true,
      session: { id: "session_created" },
    });
  });

  it("does not reuse an inactive empty UI session for a prompt by default", async () => {
    const active = uiSession({
      id: "session_active_non_empty",
      messages: [
        {
          createdAt: BASE_TIME,
          id: "message_1",
          parts: [{ text: "Existing", type: "text" }],
          role: "user",
        },
      ],
    });
    const inactiveEmpty = uiSession({ id: "session_inactive_empty" });

    await expect(
      createResolver({
        snapshot: snapshot({
          activeSessionId: active.id,
          sessions: [active, inactiveEmpty],
        }),
      }),
    ).resolves.toMatchObject({
      isNewSession: true,
      session: { id: "session_created" },
    });
  });

  it("reuses a core empty primary session before scanning UI-only empty sessions", async () => {
    const uiOnly = uiSession({ id: "session_ui_empty" });
    const core = coreSession({
      id: "session_core_empty",
      title: "Core empty",
    });
    const manager: InProcessSessionManager = {
      create() {
        throw new Error("create should not be called");
      },
      findReusableEmptyPrimary() {
        return Promise.resolve(core);
      },
      get() {
        return Promise.resolve(null);
      },
      listByProject() {
        return Promise.resolve([]);
      },
      listByProjectRoot() {
        return Promise.resolve([]);
      },
      update() {
        throw new Error("update should not be called");
      },
    };

    await expect(
      createResolver({
        sessionManager: manager,
        snapshot: snapshot({ sessions: [uiOnly] }),
        reuseInactiveEmptySessions: true,
      }),
    ).resolves.toMatchObject({
      isNewSession: false,
      session: { id: core.id, title: "Core empty" },
    });
  });

  it("rejects a hot empty candidate when authoritative storage says occupied", async () => {
    const active = uiSession({ id: "hot_empty" });
    await expect(
      createResolver({
        isAuthoritativelyEmpty: () => Promise.resolve(false),
        snapshot: snapshot({ activeSessionId: active.id, sessions: [active] }),
      }),
    ).resolves.toMatchObject({
      isNewSession: true,
      session: { id: "session_created" },
    });
  });

  it("finds a later cold core root after authority rejects the first metadata-empty candidate", async () => {
    const occupied = coreSession({ id: "occupied_first" });
    const empty = coreSession({ id: "cold_empty_second" });
    const manager: InProcessSessionManager = {
      create() {
        throw new Error("should reuse cold root");
      },
      findReusableEmptyPrimary() {
        return Promise.resolve(occupied);
      },
      get() {
        return Promise.resolve(null);
      },
      listByProject() {
        return Promise.resolve([]);
      },
      listByProjectRoot() {
        return Promise.resolve([occupied, empty]);
      },
      update() {
        throw new Error("update should not be called");
      },
    };

    await expect(
      createResolver({
        isAuthoritativelyEmpty: (id) => Promise.resolve(id === empty.id),
        reuseInactiveEmptySessions: true,
        sessionManager: manager,
        snapshot: snapshot({ sessions: [] }),
      }),
    ).resolves.toMatchObject({
      isNewSession: false,
      session: { id: "cold_empty_second" },
    });
  });

  it("reuses a UI empty session when no active or core session is reusable", async () => {
    const uiOnly = uiSession({ id: "session_ui_empty" });

    await expect(
      createResolver({
        snapshot: snapshot({ sessions: [uiOnly] }),
        reuseInactiveEmptySessions: true,
      }),
    ).resolves.toMatchObject({
      isNewSession: false,
      session: { id: uiOnly.id },
    });
  });

  it("creates a session when there are no reusable candidates", async () => {
    await expect(
      createResolver({ snapshot: snapshot({ sessions: [] }) }),
    ).resolves.toMatchObject({
      isNewSession: true,
      session: { id: "session_created" },
    });
  });
});
