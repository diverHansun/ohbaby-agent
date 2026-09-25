import { describe, expect, it } from "vitest";
import type { UiPermissionRequest } from "ohbaby-sdk";
import { createOhbabyWebRuntime } from "./client.js";
import type { WebSseEvent } from "./wire.js";

const binding = {
  permissionEpoch: "epoch",
  rootSessionId: "root",
  bindingGeneration: 1,
};
const request: UiPermissionRequest = {
  id: "permission",
  sessionId: "child",
  rootSessionId: "root",
  runId: "child-run",
  callId: "call",
  messageId: "message",
  createdAt: 1,
  sourceLabel: "Researcher",
  title: "Allow?",
  description: "edit a.ts",
  choices: [{ id: "allow_once", label: "Allow once", intent: "allow" }],
};
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function frame(payload: WebSseEvent, id = 1): Uint8Array {
  return new TextEncoder().encode(
    `id: ${String(id)}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}
interface FixtureOptions {
  readonly selectedChild?: boolean;
  readonly query?: (count: number) => Promise<Response>;
  readonly reply?: Promise<Response>;
  readonly selection?: Promise<Response>;
}
function fixture(options: FixtureOptions = {}): {
  runtime: ReturnType<typeof createOhbabyWebRuntime>;
  history: ReturnType<typeof deferred<Response>>;
  replies: unknown[];
  queryCount(): number;
  endStream(): void;
  failStream(): void;
  emit: (payload: WebSseEvent, id?: number) => void;
} {
  const history = deferred<Response>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let selected = binding;
  const replies: unknown[] = [];
  let queryCount = 0;
  const fetchImpl: typeof fetch = (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname === "/v1/scopes")
      return Promise.resolve(
        Response.json({
          ok: true,
          scopes: [
            {
              directory: "/repo",
              available: true,
              loaded: true,
              position: 0,
              lastOpenedAt: 0,
            },
          ],
        }),
      );
    if (url.pathname === "/v1/clients")
      return Promise.resolve(
        Response.json({ ok: true, clientId: "client", ...selected }),
      );
    if (url.pathname === "/v1/events")
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              stream = controller;
              init.signal?.addEventListener(
                "abort",
                () => {
                  try {
                    controller.close();
                  } catch {
                    /* already ended */
                  }
                },
                {
                  once: true,
                },
              );
              controller.enqueue(
                frame({ type: "hello", clientId: "client", ...selected }),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    if (url.pathname === "/v1/snapshot") return history.promise;
    if (url.pathname === "/v1/model")
      return Promise.resolve(
        Response.json(
          { error: { message: "Model unavailable" } },
          { status: 503 },
        ),
      );
    if (url.pathname === "/v1/sessions/index")
      return Promise.resolve(
        Response.json({
          ok: true,
          sessions: [
            {
              id: selected.rootSessionId,
              title: "Root",
              ...(options.selectedChild
                ? { parentId: "parent", isSubagent: true }
                : {}),
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            },
          ],
        }),
      );
    if (url.pathname === "/v1/permissions") {
      queryCount += 1;
      if (options.query) return options.query(queryCount);
      return Promise.resolve(
        Response.json({
          ok: true,
          snapshot: {
            ...selected,
            permissionRevision: 1,
            requests: selected.rootSessionId === "root" ? [request] : [],
          },
        }),
      );
    }
    if (url.pathname.startsWith("/v1/permissions/")) {
      replies.push(
        JSON.parse(typeof init.body === "string" ? init.body : "null"),
      );
      return options.reply ?? Promise.resolve(Response.json({ ok: true }));
    }
    if (url.pathname === "/v1/prompts") {
      return Promise.resolve(
        Response.json({
          ok: true,
          ...selected,
          promptId: "prompt",
          clientRequestId: "client-prompt",
          userMessageId: "message",
          sessionId: selected.rootSessionId,
          status: "accepted",
          createdAt: "2026-09-25T00:00:00Z",
        }),
      );
    }
    if (url.pathname === "/v1/sessions/other/select") {
      selected = { ...binding, rootSessionId: "other", bindingGeneration: 2 };
      return (
        options.selection ??
        Promise.resolve(Response.json({ ok: true, ...selected }))
      );
    }
    return Promise.resolve(Response.json({ ok: true, model: null }));
  };
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://daemon",
      clientId: "client",
      token: "test",
      directory: "/repo",
    },
    { fetch: fetchImpl },
  );
  return {
    runtime,
    history,
    replies,
    queryCount: () => queryCount,
    endStream(): void {
      stream.close();
    },
    failStream(): void {
      stream.error(new Error("Stream failed"));
    },
    emit: (payload: WebSseEvent, id = 1): void => {
      stream.enqueue(frame(payload, id));
    },
  };
}

describe("independent web approval recovery", () => {
  it("keeps new approvals actionable after more than five unchanged hellos and prompt receipts", async () => {
    const test = fixture();
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      for (let prompt = 0; prompt < 6; prompt++) {
        test.emit({ type: "hello", clientId: "client", ...binding });
        await test.runtime.client?.submitPromptAccepted(
          `Prompt ${String(prompt)}`,
          { sessionId: "root" },
        );
        for (let step = 0; step < 30; step++) await Promise.resolve();
      }
      expect(test.runtime.store.getSnapshot().permissionSync).toMatchObject({
        status: "ready",
        attempts: 1,
      });
      expect(test.queryCount()).toBe(1);
      const next = {
        ...request,
        createdAt: 2,
        id: "later-approval",
        callId: "later-call",
      };
      test.emit({
        type: "ui.event",
        event: {
          type: "permission.requested",
          ...binding,
          permissionRevision: 2,
          request: next,
        },
      });
      await expect
        .poll(() =>
          test.runtime.store
            .getSnapshot()
            .permissionSync.requests.map((item) => item.id),
        )
        .toEqual([request.id, next.id]);
      await expect(
        test.runtime.client?.respondPermission(next.id, {
          choiceId: "allow_once",
        }),
      ).resolves.toBeUndefined();
      expect(test.replies).toEqual([
        { response: { choiceId: "allow_once" }, context: binding },
      ]);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("keeps an abnormal selected child unready while history waits and asks for a main session", async () => {
    const test = fixture({ selectedChild: true });
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("error");
      expect(test.runtime.store.getSnapshot().permissionSync.error).toContain(
        "Return to a main session to approve requests.",
      );
      expect(test.runtime.store.getSnapshot().permissionSync.requests).toEqual(
        [],
      );
      expect(test.runtime.store.getSnapshot().view.snapshot).toBeNull();
      expect(test.queryCount()).toBe(0);
      await expect(
        test.runtime.client?.respondPermission(request.id, {
          choiceId: "allow_once",
        }),
      ).rejects.toThrow("Approvals are not synchronized");
      expect(test.replies).toEqual([]);
    } finally {
      await test.runtime.dispose();
    }
  });

  it("becomes ready and answers while history is still pending and model loading failed", async () => {
    const fixtureState = fixture();
    const { runtime } = fixtureState;
    try {
      await runtime.ready;
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      expect(runtime.store.getSnapshot().view.snapshot).toBeNull();
      expect(runtime.store.getSnapshot().permissionSync.requests).toEqual([
        request,
      ]);
      await runtime.client?.respondPermission("permission", {
        choiceId: "allow_once",
      });
      expect(fixtureState.replies).toEqual([
        { response: { choiceId: "allow_once" }, context: binding },
      ]);
      expect(runtime.store.getSnapshot().connectionState).toBe("live");
    } finally {
      await runtime.dispose();
    }
  });
  it("accepts approval events before global cursors and never replaces them with a late chat snapshot", async () => {
    const { runtime, history, emit } = fixture();
    try {
      await runtime.ready;
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      runtime.store.applyEvent(
        { type: "runtime.updated", status: { kind: "idle" } },
        500,
      );
      emit(
        {
          type: "ui.event",
          event: {
            type: "permission.resolved",
            ...binding,
            permissionRevision: 2,
            requestId: request.id,
            sessionId: request.sessionId,
            reason: "once",
          },
        },
        2,
      );
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.requests.length)
        .toBe(0);
      history.resolve(
        Response.json({
          ok: true,
          seqNum: 600,
          snapshot: {
            activeSessionId: "root",
            sessions: [],
            runs: [],
            permissions: [request],
            status: { kind: "idle" },
          },
        }),
      );
      await expect
        .poll(() => runtime.store.getSnapshot().view.snapshot !== null)
        .toBe(true);
      expect(runtime.store.getSnapshot().permissionSync.requests).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
  it("selects a new approval scope without waiting for chat history", async () => {
    const { runtime } = fixture();
    try {
      await runtime.ready;
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      await runtime.selectSession("other");
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      expect(runtime.store.getSnapshot().permissionSync).toMatchObject({
        binding: { rootSessionId: "other", bindingGeneration: 2 },
        requests: [],
      });
    } finally {
      await runtime.dispose();
    }
  });
  it("keeps reading SSE while the approval HTTP baseline is pending", async () => {
    const baseline = deferred<Response>();
    const { runtime, emit } = fixture({ query: () => baseline.promise });
    try {
      await runtime.ready;
      let delivered = false;
      runtime.client?.subscribePermissionEvents(() => {
        delivered = true;
      });
      emit(
        {
          type: "ui.event",
          event: {
            type: "permission.resolved",
            ...binding,
            permissionRevision: 2,
            requestId: request.id,
            sessionId: request.sessionId,
            reason: "once",
          },
        },
        2,
      );
      emit(
        {
          type: "ui.event",
          event: {
            type: "command.catalog.updated",
            version: "after-permission",
            timestamp: 1,
          },
        },
        3,
      );
      await expect.poll(() => delivered).toBe(true);
      baseline.resolve(
        Response.json({
          ok: true,
          snapshot: { ...binding, permissionRevision: 1, requests: [request] },
        }),
      );
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      await expect
        .poll(() => runtime.store.getSnapshot().permissionSync.requests.length)
        .toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
  it("keeps a delayed selection receipt disabled after stream failure until hello", async () => {
    const selection = deferred<Response>();
    const test = fixture({ selection: selection.promise });
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      const choosing = test.runtime.selectSession("other");
      test.failStream();
      await expect
        .poll(() => test.runtime.store.getSnapshot().error)
        .toBe("Stream failed");
      selection.resolve(
        Response.json({
          ok: true,
          ...binding,
          rootSessionId: "other",
          bindingGeneration: 2,
        }),
      );
      await choosing;
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(test.runtime.store.getSnapshot().permissionSync.status).not.toBe(
        "ready",
      );
      expect(test.queryCount()).toBe(1);
    } finally {
      await test.runtime.dispose();
    }
  });
  it("isolates a failed permission observer from healthy observers and recovery", async () => {
    const test = fixture();
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      let failedCalls = 0;
      let delivered = 0;
      test.runtime.client?.subscribePermissionEvents(
        () => {
          failedCalls += 1;
          throw new Error("Observer failed");
        },
        () => {
          throw new Error("Failure observer failed");
        },
      );
      test.runtime.client?.subscribePermissionEvents(() => {
        delivered += 1;
      });
      for (const revision of [2, 3]) {
        test.emit(
          {
            type: "ui.event",
            event: {
              type: "permission.resolved",
              ...binding,
              permissionRevision: revision,
              requestId: request.id,
              sessionId: request.sessionId,
              reason: "once",
            },
          },
          revision,
        );
        await expect.poll(() => delivered).toBe(revision - 1);
      }
      expect(failedCalls).toBe(1);
      expect(test.queryCount()).toBe(1);
      expect(test.runtime.store.getSnapshot().permissionSync.status).toBe(
        "ready",
      );
    } finally {
      await test.runtime.dispose();
    }
  });
  it("revokes readiness at end of stream and re-queries after automatic reconnect hello", async () => {
    const next = deferred<Response>();
    const test = fixture({
      query: (count) =>
        count === 1
          ? Promise.resolve(
              Response.json({
                ok: true,
                snapshot: {
                  ...binding,
                  permissionRevision: 1,
                  requests: [request],
                },
              }),
            )
          : next.promise,
    });
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      test.endStream();
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("syncing");
      await expect.poll(() => test.queryCount()).toBe(2);
      expect(test.runtime.store.getSnapshot().permissionSync.status).toBe(
        "syncing",
      );
      next.resolve(
        Response.json({
          ok: true,
          snapshot: { ...binding, permissionRevision: 2, requests: [] },
        }),
      );
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      expect(test.runtime.store.getSnapshot().permissionSync.requests).toEqual(
        [],
      );
    } finally {
      await test.runtime.dispose();
    }
  });
  it("treats not-pending as a synchronization trigger rather than a failed action", async () => {
    const test = fixture({
      query: (count) =>
        Promise.resolve(
          Response.json({
            ok: true,
            snapshot: {
              ...binding,
              permissionRevision: count,
              requests: count === 1 ? [request] : [],
            },
          }),
        ),
      reply: Promise.resolve(
        Response.json(
          {
            error: {
              code: "PERMISSION_NOT_PENDING",
              message: "Already revoked",
            },
          },
          { status: 409 },
        ),
      ),
    });
    try {
      await test.runtime.ready;
      await expect
        .poll(() => test.runtime.store.getSnapshot().permissionSync.status)
        .toBe("ready");
      await expect(
        test.runtime.client?.respondPermission(request.id, {
          choiceId: "allow_once",
        }),
      ).resolves.toBeUndefined();
      await expect
        .poll(
          () => test.runtime.store.getSnapshot().permissionSync.requests.length,
        )
        .toBe(0);
      expect(test.queryCount()).toBe(2);
    } finally {
      await test.runtime.dispose();
    }
  });
});
