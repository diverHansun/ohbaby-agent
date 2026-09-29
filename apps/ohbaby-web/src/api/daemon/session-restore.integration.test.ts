import { sessionViewFromSnapshot } from "./session-recovery.test-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPermissionBinding, UiSnapshot } from "ohbaby-sdk";
import { createOhbabyWebRuntime } from "../../runtime.js";
import {
  readWebNavigationState,
  writeWebNavigationState,
} from "./navigation-state.js";
import type { WebStartupIntent } from "./wire.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Fixture {
  runtime: ReturnType<typeof createOhbabyWebRuntime>;
  selections: string[];
  holdIndex(): void;
  releaseIndex(): void;
  releaseHistory(): void;
  releaseWorkspaceRefresh(): void;
  recoverIndexAndHello(): void;
  reconnectWithRecoveredIndex(): void;
}
function fixture(
  startupIntent?: WebStartupIntent,
  options: {
    remembered?: "child" | "missing";
    failIndex?: boolean;
    freshRoot?: boolean;
    holdWorkspaceRefresh?: boolean;
  } = {},
): Fixture {
  const history = deferred<Response>();
  const index = deferred<undefined>();
  const workspaceRefresh = deferred<undefined>();
  let scopeCalls = 0;
  let delayIndex = false;
  let selected: string | null = options.freshRoot
    ? null
    : (startupIntent?.resumeSessionId ?? "default");
  let generation = 1;
  let snapshotCalls = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const selections: string[] = [];
  const closedStreams = new WeakSet<
    ReadableStreamDefaultController<Uint8Array>
  >();
  const sessions = ["default", "remembered", "explicit"]
    .filter((id) => options.remembered !== "missing" || id !== "remembered")
    .map((id) => ({
      id,
      title: id,
      ...(options.remembered === "child" && id === "remembered"
        ? { parentId: "default", isSubagent: true }
        : {}),
      createdAt: "2026-09-25",
      updatedAt: "2026-09-25",
    }));
  const binding = (): UiPermissionBinding & {
    runtimeEpoch: string;
    sessionRecoveryVersion: number;
  } => ({
    runtimeEpoch: "epoch",
    sessionRecoveryVersion: 1,
    permissionEpoch: "epoch",
    rootSessionId: selected,
    bindingGeneration: generation,
  });
  const snapshot = (activeSessionId: string): UiSnapshot => ({
    activeSessionId,
    sessions: sessions.map((session) => ({
      ...session,
      messages: [
        {
          id: `${session.id}-message`,
          role: "assistant" as const,
          createdAt: "2026-09-25",
          parts: [{ type: "text" as const, text: `${session.id} transcript` }],
        },
      ],
    })),
    permission: { level: "default", mode: "auto", sessionRules: [] },
    permissions: [],
    runs: [],
    status: { kind: "idle" },
  });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/scopes") {
      scopeCalls += 1;
      if (scopeCalls > 1 && options.holdWorkspaceRefresh)
        await workspaceRefresh.promise;
      return Response.json({
        ok: true,
        scopes: [
          {
            directory: "/repo",
            available: true,
            loaded: true,
            lastOpenedAt: 0,
            position: 0,
          },
        ],
      });
    }
    if (path === "/v1/clients")
      return Response.json({ ok: true, clientId: "client", ...binding() });
    if (path === "/v1/events")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "hello", clientId: "client", ...binding() })}\n\n`,
              ),
            );
            request.signal.addEventListener(
              "abort",
              () => {
                if (!closedStreams.has(controller)) {
                  closedStreams.add(controller);
                  controller.close();
                }
              },
              {
                once: true,
              },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path.endsWith("/view")) {
      snapshotCalls += 1;
      return snapshotCalls === 1 && !options.freshRoot
        ? history.promise
        : Response.json({
            ok: true,
            seqNum: 2,
            view: sessionViewFromSnapshot(
              snapshot(selected ?? "default"),
              2,
              generation,
            ),
          });
    }
    if (path === "/v1/model") return new Promise<Response>(() => undefined);
    if (path === "/v1/sessions/index") {
      if (delayIndex) await index.promise;
      if (options.failIndex)
        return Response.json(
          { error: { message: "index unavailable" } },
          { status: 503 },
        );
      return Response.json({ ok: true, sessions });
    }
    if (path === "/v1/commands" && request.method === "GET")
      return Response.json({
        ok: true,
        catalog: {
          version: "1",
          commands: [
            {
              action: "executeCommand",
              argumentMode: "argv",
              category: "system",
              description: "New session",
              executionKind: "passthrough",
              id: "new",
              path: ["new"],
              source: "builtin",
              surfaces: ["tui"],
            },
          ],
        },
      });
    if (path === "/v1/commands" && request.method === "POST") {
      selected = "explicit";
      generation += 1;
      stream?.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "hello", clientId: "client", ...binding() })}\n\n`,
        ),
      );
      const invocation = (await request.json()) as {
        clientInvocationId: string;
      };
      return Response.json({
        ok: true,
        status: "completed",
        commandRunId: "new-command",
        clientInvocationId: invocation.clientInvocationId,
        outputCount: 0,
        eventCount: 0,
      });
    }
    if (path === "/v1/permissions")
      return Response.json({
        ok: true,
        snapshot: { ...binding(), permissionRevision: 0, requests: [] },
      });
    const match = /^\/v1\/sessions\/([^/]+)\/select$/.exec(path);
    if (match?.[1]) {
      selected = match[1];
      generation += 1;
      selections.push(selected);
      if (options.freshRoot)
        stream?.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "hello", clientId: "client", ...binding() })}\n\n`,
          ),
        );
      return Response.json({ ok: true, ...binding() });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://127.0.0.1:4096",
      clientId: "client",
      directory: "/repo",
      token: "token",
      ...(startupIntent ? { startupIntent } : {}),
    },
    { fetch: fetchImpl },
  );
  return {
    runtime,
    selections,
    releaseWorkspaceRefresh(): void {
      workspaceRefresh.resolve(undefined);
    },
    reconnectWithRecoveredIndex(): void {
      options.failIndex = false;
      if (stream) {
        closedStreams.add(stream);
        stream.close();
      }
    },
    recoverIndexAndHello(): void {
      options.failIndex = false;
      stream?.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "hello", clientId: "client", ...binding() })}\n\n`,
        ),
      );
    },
    holdIndex(): void {
      delayIndex = true;
    },
    releaseIndex(): void {
      index.resolve(undefined);
    },
    releaseHistory(): void {
      history.resolve(
        Response.json({
          ok: true,
          seqNum: 1,
          view: sessionViewFromSnapshot(
            snapshot(startupIntent?.resumeSessionId ?? "default"),
          ),
        }),
      );
    },
  };
}

describe("remembered Web session restoration", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    writeWebNavigationState({
      selectedDirectory: "/repo",
      sessionByDirectory: { "/repo": "remembered" },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores from metadata before delayed history/model and preserves the selection when old history arrives", async () => {
    const app = fixture();
    try {
      await app.runtime.ready;
      expect(await app.runtime.client?.getSelectedSessionId()).toBe(
        "remembered",
      );
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().permissionSync.status).toBe(
          "ready",
        );
      });
      expect(
        app.runtime.store.getSnapshot().view.snapshot?.activeSessionId,
      ).toBe("remembered");
      app.releaseHistory();
      await vi.waitFor(() => {
        expect(
          app.runtime.store.getSnapshot().view.snapshot?.activeSessionId,
        ).toBe("remembered");
      });
      expect(readWebNavigationState().sessionByDirectory["/repo"]).toBe(
        "remembered",
      );
    } finally {
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });

  it.each<WebStartupIntent>([
    { resumeSessionId: "explicit" },
    { startupSessionMode: { type: "fresh" } },
  ])(
    "keeps explicit startup intent %j ahead of remembered navigation",
    async (intent) => {
      const app = fixture(intent);
      app.releaseHistory();
      try {
        await app.runtime.ready;
        expect(app.selections).toEqual([]);
        expect(await app.runtime.client?.getSelectedSessionId()).toBe(
          intent.resumeSessionId ?? "default",
        );
      } finally {
        await app.runtime.dispose();
      }
    },
  );

  it.each(["child", "missing"] as const)(
    "ignores a remembered %s session without failing the live connection",
    async (remembered) => {
      const app = fixture(undefined, { remembered });
      try {
        await app.runtime.ready;
        expect(app.selections).toEqual([]);
        expect(await app.runtime.client?.getSelectedSessionId()).toBe(
          "default",
        );
        expect(app.runtime.store.getSnapshot().connectionState).toBe("live");
      } finally {
        app.releaseHistory();
        await app.runtime.dispose();
      }
    },
  );

  it("keeps the live transport when optional restoration metadata fails", async () => {
    const app = fixture(undefined, { failIndex: true });
    try {
      await app.runtime.ready;
      expect(app.runtime.store.getSnapshot().connectionState).toBe("live");
      expect(app.runtime.client).not.toBeNull();
      expect(app.selections).toEqual([]);
      expect(readWebNavigationState().sessionByDirectory["/repo"]).toBe(
        "remembered",
      );
      await app.runtime.selectSession("explicit");
      expect(readWebNavigationState().sessionByDirectory["/repo"]).toBe(
        "explicit",
      );
    } finally {
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });

  it("does not override a new-session command while restoration metadata is pending", async () => {
    const app = fixture();
    app.holdIndex();
    try {
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().connectionState).toBe("live");
      });
      await app.runtime.executeSlashCommand({ text: "/new" });
      app.releaseIndex();
      await app.runtime.ready;
      expect(await app.runtime.client?.getSelectedSessionId()).toBe("explicit");
      expect(app.selections).toEqual([]);
    } finally {
      app.releaseIndex();
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });

  it("does not override a user selection made while restoration metadata is pending", async () => {
    const app = fixture();
    app.holdIndex();
    try {
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().connectionState).toBe("live");
      });
      await app.runtime.selectSession("explicit");
      app.releaseIndex();
      await app.runtime.ready;
      expect(await app.runtime.client?.getSelectedSessionId()).toBe("explicit");
      expect(app.selections).toEqual(["explicit"]);
      app.releaseHistory();
      await vi.waitFor(() => {
        expect(
          app.runtime.store.getSnapshot().view.snapshot?.activeSessionId,
        ).toBe("explicit");
      });
      expect(readWebNavigationState().sessionByDirectory["/repo"]).toBe(
        "explicit",
      );
    } finally {
      app.releaseIndex();
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });
  it("keeps an explicit fresh startup empty when recovered index contains a remembered session", async () => {
    const app = fixture(
      { startupSessionMode: { type: "fresh" } },
      { failIndex: true, freshRoot: true },
    );
    try {
      await app.runtime.ready;
      app.reconnectWithRecoveredIndex();
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().sessionIndex).toHaveLength(3);
      });
      expect(app.selections).toEqual([]);
      expect(await app.runtime.client?.getSelectedSessionId()).toBeNull();
      expect(app.runtime.store.getSnapshot().sessionSync.scope).toBeNull();
      expect(app.runtime.store.getSnapshot().view.snapshot).toBeNull();
    } finally {
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });

  it("restores when index recovery finishes before bootstrap workspace metadata", async () => {
    const app = fixture(undefined, {
      failIndex: true,
      freshRoot: true,
      holdWorkspaceRefresh: true,
    });
    try {
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().error).toContain(
          "index unavailable",
        );
      });
      app.reconnectWithRecoveredIndex();
      await vi.waitFor(() => {
        expect(app.runtime.store.getSnapshot().sessionIndex).toHaveLength(3);
      });
      app.releaseWorkspaceRefresh();
      await app.runtime.ready;
      await vi.waitFor(() => {
        const state = app.runtime.store.getSnapshot();
        expect(state.sessionSync.status).toBe("ready");
        expect(state.view.snapshot?.activeSessionId).toBe("remembered");
        expect(state.view.snapshot?.sessions[0]?.messages[0]?.parts).toEqual([
          { type: "text", text: "remembered transcript" },
        ]);
      });
    } finally {
      app.releaseWorkspaceRefresh();
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });

  it("recovers the actual transcript from fresh binding after index failure and SSE reconnect", async () => {
    const app = fixture(undefined, { failIndex: true, freshRoot: true });
    try {
      await app.runtime.ready;
      expect(app.runtime.store.getSnapshot().sessionSync.scope).toBeNull();
      app.reconnectWithRecoveredIndex();
      await vi.waitFor(() => {
        const state = app.runtime.store.getSnapshot();
        expect(state.sessionSync.status).toBe("ready");
        expect(state.sessionSync.scope?.sessionId).toBe("remembered");
        expect(state.view.snapshot?.sessions[0]?.messages[0]?.parts).toEqual([
          { type: "text", text: "remembered transcript" },
        ]);
      });
      expect(app.selections).toEqual(["remembered"]);
    } finally {
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });
  it("restores the remembered selection after reconnect metadata recovers from a bootstrap failure", async () => {
    const app = fixture(undefined, { failIndex: true });
    try {
      await app.runtime.ready;
      expect(app.selections).toEqual([]);
      app.recoverIndexAndHello();
      await vi.waitFor(() => {
        expect(app.selections).toEqual(["remembered"]);
      });
      expect(await app.runtime.client?.getSelectedSessionId()).toBe(
        "remembered",
      );
    } finally {
      app.releaseHistory();
      await app.runtime.dispose();
    }
  });
});
