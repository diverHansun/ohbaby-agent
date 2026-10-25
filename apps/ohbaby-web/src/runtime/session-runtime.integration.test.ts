import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWebNavigationState,
  writeWebNavigationState,
} from "../api/daemon/navigation-state.js";
import type { WebStartupIntent } from "../api/daemon/wire.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

import { DEFAULT, fakeDaemon, session } from "./fake-daemon.test-support.js";

const runtimes: OhbabyWebRuntime[] = [];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: (): void => {
      values.clear();
    },
    getItem: (key): string | null => values.get(key) ?? null,
    key: (index): string | null => [...values.keys()][index] ?? null,
    get length(): number {
      return values.size;
    },
    removeItem: (key): void => {
      values.delete(key);
    },
    setItem: (key, value): void => {
      values.set(key, value);
    },
  };
}

function start(
  daemon: ReturnType<typeof fakeDaemon>,
  options: { directory?: string; startupIntent?: WebStartupIntent } = {},
): OhbabyWebRuntime {
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://127.0.0.1:4096",
      clientId: "web",
      token: "token",
      ...options,
    },
    { fetch: daemon.fetch },
  );
  runtimes.push(runtime);
  return runtime;
}

function instanceDirectory(runtime: OhbabyWebRuntime): string | null {
  return runtime.getWorkspaceSnapshot().selectedDirectory;
}

async function waitForSession(
  runtime: OhbabyWebRuntime,
  sessionId: string | null,
): Promise<void> {
  await vi.waitFor(() => {
    const snapshot = runtime.store.getSnapshot();
    expect(snapshot.permissionSync.binding?.rootSessionId).toBe(sessionId);
    if (sessionId) expect(snapshot.sessionSync.status).toBe("ready");
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.unstubAllGlobals();
});

describe("session-centric runtime", () => {
  it.each([null, "/b"])(
    "reloads the new draft in %s instead of reopening the previous session",
    async (projectDirectory) => {
      vi.stubGlobal("localStorage", memoryStorage());
      vi.stubGlobal("sessionStorage", memoryStorage());
      const daemon = fakeDaemon([session("previous", null, DEFAULT)]);
      const runtime = start(daemon);
      await runtime.ready;
      await runtime.openSession("previous");
      await waitForSession(runtime, "previous");
      expect(readWebNavigationState().lastSession?.sessionId).toBe("previous");

      await runtime.openDraft(projectDirectory);
      await waitForSession(runtime, null);
      expect(readWebNavigationState().lastSession).toBeNull();
      await runtime.dispose();

      const reloaded = start(daemon);
      await reloaded.ready;
      await waitForSession(reloaded, null);
      expect(reloaded.draft.getSnapshot().projectDirectory).toBe(
        projectDirectory,
      );
      expect(instanceDirectory(reloaded)).toBe(projectDirectory ?? DEFAULT);
    },
  );

  it("starts a draft in the default workspace without creating a session; the first prompt creates it there", async () => {
    const daemon = fakeDaemon();
    const runtime = start(daemon);
    await runtime.ready;
    await waitForSession(runtime, null);

    expect(instanceDirectory(runtime)).toBe(DEFAULT);
    expect(
      daemon.requests.some(
        (request) =>
          request.method === "POST" && request.path === "/v1/sessions",
      ),
    ).toBe(false);

    const receipt = await runtime.submitPrompt("hello", {
      clientRequestId: "first",
    });
    expect(daemon.sessions.get(receipt.sessionId)).toMatchObject({
      projectDirectory: null,
      workingDirectory: DEFAULT,
    });
    await vi.waitFor(() => {
      expect(
        runtime.catalog.getSnapshot().sessions.map((value) => value.id),
      ).toContain(receipt.sessionId);
    });
  });

  it("creates the first session in the draft's project", async () => {
    const daemon = fakeDaemon();
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openDraft("/a");
    await waitForSession(runtime, null);

    expect(instanceDirectory(runtime)).toBe("/a");
    expect(runtime.draft.getSnapshot().projectDirectory).toBe("/a");
    const receipt = await runtime.submitPrompt("in a");
    expect(daemon.sessions.get(receipt.sessionId)?.projectDirectory).toBe("/a");
  });

  it("opens a session removed from its project at its working directory, not the default workspace", async () => {
    const daemon = fakeDaemon([session("out", null, "/a")]);
    const runtime = start(daemon);
    await runtime.ready;

    await runtime.openSession("out");
    await waitForSession(runtime, "out");

    expect(instanceDirectory(runtime)).toBe("/a");
    expect(
      daemon.requests.find((request) => request.path.endsWith("/out/select"))
        ?.directory,
    ).toBe("/a");
  });

  it("follows SESSION_MOVED to the new directory and resends the same request once", async () => {
    const daemon = fakeDaemon([session("s1", "/a", "/a")]);
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openSession("s1");
    await waitForSession(runtime, "s1");
    const moved = daemon.sessions.get("s1");
    if (moved) moved.pendingWorkingDirectory = "/b";

    const receipt = await runtime.submitPrompt("next turn", {
      clientRequestId: "r1",
      sessionId: "s1",
    });

    expect(receipt).toMatchObject({ sessionId: "s1", clientRequestId: "r1" });
    expect(instanceDirectory(runtime)).toBe("/b");
    const prompts = daemon.requests.filter(
      (request) => request.path === "/v1/prompts",
    );
    expect(prompts.map((request) => request.directory)).toEqual(["/a", "/b"]);
    expect(prompts.map((request) => request.body)).toEqual([
      { clientRequestId: "r1", sessionId: "s1", text: "next turn" },
      { clientRequestId: "r1", sessionId: "s1", text: "next turn" },
    ]);
    expect(runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
  });

  it("stops after two resends when the session keeps moving", async () => {
    const daemon = fakeDaemon([session("s1", "/a", "/a")]);
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openSession("s1");
    await waitForSession(runtime, "s1");
    const pingPong = (sessionId: string, directory: string): string => {
      const target = directory === "/a" ? "/b" : "/a";
      const value = daemon.sessions.get(sessionId);
      if (value) value.pendingWorkingDirectory = target;
      return target;
    };
    daemon.movedTo = pingPong;

    await expect(
      runtime.submitPrompt("again", { clientRequestId: "r2", sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
    expect(
      daemon.requests.filter((request) => request.path === "/v1/prompts"),
    ).toHaveLength(3);
  });

  it("archives and exports a session of another directory without switching the live stream", async () => {
    const daemon = fakeDaemon([
      session("here", "/a", "/a", "2026-10-02T00:00:00.000Z"),
      session("there", "/b", "/b"),
    ]);
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openSession("here");
    await waitForSession(runtime, "here");
    const liveClient = runtime.client;

    const exported = await runtime.exportSession("there", "jsonl");
    await runtime.archiveSession("there");

    expect(exported.filename).toBe("there.jsonl");
    expect(runtime.client).toBe(liveClient);
    expect(instanceDirectory(runtime)).toBe("/a");
    expect(daemon.abortedStreams).not.toContain("/a");
    const archive = daemon.requests.find((request) =>
      request.path.endsWith("/there/archive"),
    );
    expect(archive?.directory).toBe("/b");
    expect(archive?.clientId).not.toBe(
      daemon.requests.find(
        (request) =>
          request.path === "/v1/clients" && request.directory === "/a",
      )?.clientId,
    );
    expect(
      runtime.catalog.getSnapshot().sessions.map((value) => value.id),
    ).toEqual(["here"]);
    expect(
      runtime.store.getSnapshot().permissionSync.binding?.rootSessionId,
    ).toBe("here");
  });

  it("returns to a draft after archiving the open session, and restores the row when archiving fails", async () => {
    const daemon = fakeDaemon([session("open", null, DEFAULT)]);
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openSession("open");
    await waitForSession(runtime, "open");

    await runtime.archiveSession("open");
    await waitForSession(runtime, null);
    expect(instanceDirectory(runtime)).toBe(DEFAULT);

    daemon.sessions.set("kept", session("kept", "/b", "/b"));
    await runtime.refreshCatalog();
    daemon.failing.add("/v1/sessions/kept/archive");
    await expect(runtime.archiveSession("kept")).rejects.toThrow("unavailable");
    expect(
      runtime.catalog.getSnapshot().sessions.map((value) => value.id),
    ).toEqual(["kept"]);
  });

  it("refresh re-reads at least the loaded range and drops rows archived elsewhere", async () => {
    const daemon = fakeDaemon(
      Array.from({ length: 150 }, (_, index) =>
        session(
          `s${String(index).padStart(3, "0")}`,
          null,
          DEFAULT,
          `2026-09-${String(30 - (index % 28)).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
    );
    const runtime = start(daemon);
    await runtime.ready;
    expect(runtime.catalog.getSnapshot().sessions).toHaveLength(100);

    await runtime.loadMoreSessions((rows) => rows.length >= 150);
    expect(runtime.catalog.getSnapshot().sessions).toHaveLength(150);
    expect(runtime.catalog.getSnapshot().nextCursor).toBeUndefined();

    const gone = daemon.sessions.get("s001");
    if (gone) gone.archived = true;
    const before = daemon.requests.length;
    await runtime.refreshCatalog();

    const pages = daemon.requests
      .slice(before)
      .filter((request) => request.path === "/v1/sessions");
    expect(pages).toHaveLength(2);
    const ids = runtime.catalog.getSnapshot().sessions.map((value) => value.id);
    expect(ids).toHaveLength(149);
    expect(ids).not.toContain("s001");
  });

  it("keeps old rows when a refresh fails", async () => {
    const daemon = fakeDaemon([session("s1", null, DEFAULT)]);
    const runtime = start(daemon);
    await runtime.ready;
    daemon.sessions.clear();
    daemon.failing.add("/v1/sessions");

    await runtime.refreshCatalog();

    expect(
      runtime.catalog.getSnapshot().sessions.map((value) => value.id),
    ).toEqual(["s1"]);
    expect(runtime.catalog.getSnapshot().sessionsStatus).toBe("error");
  });

  it("opens a hashed session at its current request directory even when the hash names the old one", async () => {
    const moved = session("linked", "/b", "/b");
    const daemon = fakeDaemon([moved]);
    const runtime = start(daemon, {
      directory: "/a",
      startupIntent: { resumeSessionId: "linked" },
    });
    await runtime.ready;
    await waitForSession(runtime, "linked");

    expect(instanceDirectory(runtime)).toBe("/b");
    const registration = daemon.requests.find(
      (request) => request.path === "/v1/clients",
    );
    expect(registration?.directory).toBe("/b");
    expect(registration?.body).not.toHaveProperty("startupIntent");
  });

  it("falls back to a draft when the remembered directory is unavailable", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    writeWebNavigationState({
      lastSession: { sessionId: "gone", directory: "/deleted" },
    });
    const daemon = fakeDaemon();
    daemon.unavailable.add("/deleted");
    const runtime = start(daemon);

    await runtime.ready;
    await waitForSession(runtime, null);

    expect(instanceDirectory(runtime)).toBe(DEFAULT);
    expect(readWebNavigationState().lastSession).toBeNull();
  });

  it("opens a draft when the remembered session no longer exists, so the picker matches", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    writeWebNavigationState({
      lastSession: { sessionId: "archived", directory: "/a" },
    });
    const daemon = fakeDaemon();
    const runtime = start(daemon);
    await runtime.ready;
    await waitForSession(runtime, null);

    expect(instanceDirectory(runtime)).toBe(DEFAULT);
    expect(runtime.draft.getSnapshot().projectDirectory).toBeNull();
  });

  it("keeps a running turn bound when its session has moved, and says when the next turn applies", async () => {
    const daemon = fakeDaemon([session("s1", "/a", "/a")]);
    const runtime = start(daemon);
    await runtime.ready;
    daemon.running.add("s1");
    await runtime.openSession("s1");
    await waitForSession(runtime, "s1");
    await vi.waitFor(() => {
      expect(runtime.store.getSnapshot().sessionControl?.runId).toBe("run-1");
    });
    const live = runtime.client;
    const moved = daemon.sessions.get("s1");
    if (moved) moved.pendingWorkingDirectory = "/b";

    await expect(
      runtime.submitPrompt("queued", { sessionId: "s1", clientRequestId: "q" }),
    ).rejects.toThrow("after the current turn");

    expect(runtime.client).toBe(live);
    expect(instanceDirectory(runtime)).toBe("/a");
    expect(daemon.abortedStreams).not.toContain("/a");
  });

  it("does not follow a move after the user opened something else", async () => {
    const daemon = fakeDaemon([
      session("s1", "/a", "/a"),
      session("s2", "/c", "/c"),
    ]);
    const runtime = start(daemon);
    await runtime.ready;
    await runtime.openSession("s1");
    await waitForSession(runtime, "s1");
    const moved = daemon.sessions.get("s1");
    if (moved) moved.pendingWorkingDirectory = "/b";
    let opened: Promise<void> | undefined;
    daemon.movedTo = (): string => {
      opened ??= runtime.openSession("s2");
      return "/b";
    };

    await expect(
      runtime.submitPrompt("x", { sessionId: "s1", clientRequestId: "m" }),
    ).rejects.toMatchObject({ code: "SESSION_MOVED" });
    await opened;
    await waitForSession(runtime, "s2");
    expect(instanceDirectory(runtime)).toBe("/c");
  });

  it("restores the picker to the connected project when opening a draft fails", async () => {
    const daemon = fakeDaemon();
    const runtime = start(daemon);
    await runtime.ready;
    await waitForSession(runtime, null);
    daemon.unavailable.add("/b");

    await expect(runtime.openDraft("/b")).rejects.toThrow("unavailable");

    expect(instanceDirectory(runtime)).toBe(DEFAULT);
    expect(runtime.draft.getSnapshot().projectDirectory).toBeNull();
  });

  it("does not re-read the whole list when switching instances", async () => {
    const daemon = fakeDaemon([session("s1", "/a", "/a")]);
    const runtime = start(daemon);
    await runtime.ready;
    await waitForSession(runtime, null);
    const lists = (): number =>
      daemon.requests.filter((request) => request.path === "/v1/sessions")
        .length;
    const before = lists();

    await runtime.openDraft("/a");
    await waitForSession(runtime, null);
    await runtime.openSession("s1");
    await waitForSession(runtime, "s1");

    expect(lists()).toBe(before);
  });

  it("does not let a refresh read before an archive bring the row back", async () => {
    const daemon = fakeDaemon([
      session("keep", null, DEFAULT, "2026-10-02T00:00:00.000Z"),
      session("drop", "/b", "/b"),
    ]);
    const runtime = start(daemon);
    await runtime.ready;
    let release: () => void = () => undefined;
    daemon.holdNextList = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = runtime.refreshCatalog();
    await runtime.archiveSession("drop");
    release();
    await refreshing;

    expect(
      runtime.catalog.getSnapshot().sessions.map((value) => value.id),
    ).toEqual(["keep"]);
  });
});
