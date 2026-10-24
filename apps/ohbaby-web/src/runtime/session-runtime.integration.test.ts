import type { UiGlobalSession, UiSnapshot } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoveryBinding,
  sessionViewFromSnapshot,
} from "../api/daemon/session-recovery.test-utils.js";
import type { WebStartupIntent } from "../api/daemon/wire.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

const DEFAULT = "/default";
const encoder = new TextEncoder();

interface WorldSession {
  id: string;
  title: string;
  updatedAt: string;
  projectDirectory: string | null;
  workingDirectory: string;
  pendingWorkingDirectory?: string;
  archived?: boolean;
}

interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly directory: string | undefined;
  readonly clientId: string | undefined;
  readonly body: unknown;
}

/**
 * A daemon with global routes and one instance per directory. A session is
 * owned by its request directory; prompts and selections elsewhere are
 * refused the way the server refuses them.
 */
function fakeDaemon(initial: readonly WorldSession[] = []): {
  readonly fetch: typeof fetch;
  readonly sessions: Map<string, WorldSession>;
  readonly requests: LoggedRequest[];
  readonly abortedStreams: string[];
  /** Overrides the directory a prompt for this session must move to. */
  movedTo: ((sessionId: string, directory: string) => string | null) | null;
  /** Paths answered with HTTP 500. */
  readonly failing: Set<string>;
} {
  const sessions = new Map(initial.map((session) => [session.id, session]));
  const requests: LoggedRequest[] = [];
  const abortedStreams: string[] = [];
  const clients = new Map<
    string,
    { directory: string; selected: string | null; generation: number }
  >();
  let created = 0;
  const owner = (session: WorldSession): string =>
    session.pendingWorkingDirectory ?? session.workingDirectory;
  const global = (session: WorldSession): UiGlobalSession => ({
    id: session.id,
    title: session.title,
    status: "active",
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    messageCount: 1,
    projectDirectory: session.projectDirectory,
    workingDirectory: session.workingDirectory,
    ...(session.pendingWorkingDirectory === undefined
      ? {}
      : { pendingWorkingDirectory: session.pendingWorkingDirectory }),
  });
  const snapshot = (sessionId: string | null): UiSnapshot => ({
    activeSessionId: sessionId,
    sessions: sessionId
      ? [
          {
            id: sessionId,
            title: sessions.get(sessionId)?.title ?? sessionId,
            createdAt: "2026-10-01",
            updatedAt: "2026-10-01",
            messages: [],
          },
        ]
      : [],
    permission: { level: "default", mode: "auto", sessionRules: [] },
    permissions: [],
    runs: [],
    status: { kind: "idle" },
  });
  const daemon = {
    sessions,
    requests,
    abortedStreams,
    movedTo: null as
      | ((sessionId: string, directory: string) => string | null)
      | null,
    failing: new Set<string>(),
    fetch: (async (input, init = {}) => {
      // Answer asynchronously, like the network.
      await Promise.resolve();
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;
      const rawDirectory = request.headers.get("x-ohbaby-directory");
      const directory =
        rawDirectory === null ? undefined : decodeURIComponent(rawDirectory);
      const clientId = request.headers.get("x-ohbaby-client-id") ?? undefined;
      const body: unknown =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({
        method: request.method,
        path,
        directory,
        clientId,
        body,
      });
      if (daemon.failing.has(path))
        return Response.json(
          { ok: false, error: { message: "unavailable" } },
          { status: 500 },
        );
      const client = clientId ? clients.get(clientId) : undefined;
      const binding = (): ReturnType<typeof recoveryBinding> =>
        recoveryBinding(client?.selected ?? null, client?.generation ?? 1);

      if (path === "/v1/scopes")
        return Response.json({
          ok: true,
          defaultWorkspace: { directory: DEFAULT },
          scopes: ["/a", "/b"].map((value, position) => ({
            available: true,
            directory: value,
            lastOpenedAt: 0,
            loaded: false,
            position,
          })),
        });
      if (path === "/v1/sessions" && request.method === "GET") {
        const active = [...sessions.values()]
          .filter((session) => !session.archived)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const page = active.slice(offset, offset + limit);
        return Response.json({
          ok: true,
          sessions: page.map(global),
          ...(offset + limit < active.length
            ? { nextCursor: String(offset + limit) }
            : {}),
        });
      }
      if (path === "/v1/clients" && clientId && directory) {
        clients.set(clientId, { directory, selected: null, generation: 1 });
        return Response.json({ ok: true, clientId, ...binding() });
      }
      if (path === "/v1/events" && client) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "hello", clientId, ...binding() })}\n\n`,
                ),
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  abortedStreams.push(client.directory);
                  controller.close();
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const select = /^\/v1\/sessions\/([^/]+)\/select$/.exec(path);
      if (select?.[1] && client) {
        const session = sessions.get(select[1]);
        if (!session || owner(session) !== client.directory)
          return Response.json(
            {
              ok: false,
              error: { message: "scope", code: "PERMISSION_SCOPE_CHANGED" },
            },
            { status: 409 },
          );
        client.selected = session.id;
        client.generation += 1;
        return Response.json({ ok: true, ...binding() });
      }
      if (path.endsWith("/view") && client)
        return Response.json({
          ok: true,
          seqNum: 0,
          view: sessionViewFromSnapshot(
            snapshot(client.selected),
            0,
            client.generation,
          ),
        });
      if (path.endsWith("/control") && client?.selected)
        return Response.json({
          ok: true,
          control: {
            sessionId: client.selected,
            rootSessionId: client.selected,
            runtimeEpoch: "epoch",
            bindingGeneration: client.generation,
            runId: null,
            driver: "user",
          },
        });
      if (path === "/v1/model") return Response.json({ ok: true, model: null });
      if (path === "/v1/sessions/index" && client)
        return Response.json({
          ok: true,
          sessions: [...sessions.values()]
            .filter((session) => owner(session) === client.directory)
            .map((session) => ({
              id: session.id,
              title: session.title,
              createdAt: session.updatedAt,
              updatedAt: session.updatedAt,
            })),
        });
      if (path === "/v1/permissions")
        return Response.json({
          ok: true,
          snapshot: { ...binding(), permissionRevision: 0, requests: [] },
        });
      if (path === "/v1/prompts" && client) {
        const prompt = body as {
          clientRequestId: string;
          sessionId?: string;
          text: string;
        };
        let sessionId = prompt.sessionId;
        if (sessionId !== undefined) {
          const session = sessions.get(sessionId);
          const target =
            daemon.movedTo?.(sessionId, client.directory) ??
            (session && owner(session) !== client.directory
              ? owner(session)
              : null);
          if (target)
            return Response.json(
              {
                ok: false,
                error: {
                  message: "Session moved",
                  code: "SESSION_MOVED",
                  targetDirectory: target,
                },
              },
              { status: 409 },
            );
        } else {
          created += 1;
          sessionId = `created-${String(created)}`;
          sessions.set(sessionId, {
            id: sessionId,
            title: prompt.text,
            updatedAt: `2026-10-24T00:00:0${String(created)}.000Z`,
            projectDirectory:
              client.directory === DEFAULT ? null : client.directory,
            workingDirectory: client.directory,
          });
          client.selected = sessionId;
          client.generation += 1;
        }
        return Response.json({
          ok: true,
          ...binding(),
          promptId: `prompt-${prompt.clientRequestId}`,
          clientRequestId: prompt.clientRequestId,
          userMessageId: "message",
          sessionId,
          status: "accepted",
          createdAt: "2026-10-24T00:00:00.000Z",
        });
      }
      const archive = /^\/v1\/sessions\/([^/]+)\/archive$/.exec(path);
      if (archive?.[1] && request.method === "PATCH") {
        if (!client)
          return Response.json(
            { ok: false, error: { message: "client is not registered" } },
            { status: 409 },
          );
        const session = sessions.get(archive[1]);
        if (session) session.archived = true;
        return Response.json({ ok: true });
      }
      const exported = /^\/v1\/sessions\/([^/]+)\/export$/.exec(path);
      if (exported?.[1] && client)
        return Response.json({
          ok: true,
          export: {
            filename: `${exported[1]}.jsonl`,
            mimeType: "application/x-ndjson",
            content: "{}\n",
            messageCount: 0,
          },
        });
      throw new Error(`Unexpected request ${request.method} ${path}`);
    }) as typeof fetch,
  };
  return daemon;
}

function session(
  id: string,
  projectDirectory: string | null,
  workingDirectory: string,
  updatedAt = "2026-10-01T00:00:00.000Z",
): WorldSession {
  return { id, title: id, updatedAt, projectDirectory, workingDirectory };
}

const runtimes: OhbabyWebRuntime[] = [];

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
});
