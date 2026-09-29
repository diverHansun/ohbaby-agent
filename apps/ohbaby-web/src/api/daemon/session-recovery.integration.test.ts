import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSessionView, UiBackendClient, UiEvent } from "ohbaby-sdk";
import {
  createOhbabyWebRuntime,
  type OhbabyWebRuntime,
} from "../../runtime.js";
import type { WebSseEvent } from "./wire.js";
const binding = {
  permissionEpoch: "epoch",
  runtimeEpoch: "epoch",
  sessionRecoveryVersion: 1,
  subagentConversationVersion: 1,
  rootSessionId: "root",
  bindingGeneration: 1,
};
function view(
  revision = 0,
  text = "base",
  sessionId = "root",
  generation = 1,
): UiSessionView {
  return {
    version: {
      runtimeEpoch: "epoch",
      sessionId,
      viewGeneration: "view",
      sessionRevision: revision,
    },
    bindingGeneration: generation,
    session: {
      id: sessionId,
      title: sessionId,
      createdAt: "2026",
      updatedAt: "2026",
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: "2026",
          parts: [{ id: "part", type: "text", text }],
        },
      ],
    },
    runs: [],
    prompts: [],
    history: { hasMore: false },
    reasoningMissing: false,
    todo: { status: "ready", value: null },
    goal: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(dispose.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
});
function fixture(
  options: {
    query?: (url: URL) => Promise<Response>;
    history?: (url: URL) => Promise<Response>;
    initialBinding?: Partial<Omit<typeof binding, "rootSessionId">> & {
      rootSessionId?: string | null;
    };
    receipt?: (url: URL) => Promise<Response>;
    submit?: () => Promise<Response>;
    command?: (body: string) => Response;
  } = {},
): {
  runtime: OhbabyWebRuntime;
  calls: URL[];
  requests: { url: URL; body?: string; method?: string }[];
  emit: (event: WebSseEvent, id?: number) => void;
} {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let selected: Omit<typeof binding, "rootSessionId"> & {
    rootSessionId: string | null;
  } = { ...binding, ...options.initialBinding };
  const calls: URL[] = [];
  const requests: { url: URL; body?: string; method?: string }[] = [];
  const emit = (event: WebSseEvent, id = 1): void => {
    stream.enqueue(
      new TextEncoder().encode(
        `id: ${String(id)}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );
  };
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://daemon.test",
      clientId: "client",
      token: "token",
      directory: "/repo",
    },
    {
      fetch: async (input, init = {}) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        calls.push(url);
        requests.push({
          url,
          body: typeof init.body === "string" ? init.body : undefined,
          method: init.method,
        });
        if (
          url.pathname === "/v1/commands" &&
          init.method === "POST" &&
          options.command
        )
          return options.command(
            typeof init.body === "string" ? init.body : "",
          );
        if (url.pathname === "/v1/scopes")
          return Response.json({
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
          });
        if (url.pathname === "/v1/clients")
          return Response.json({ ok: true, clientId: "client", ...selected });
        if (url.pathname === "/v1/events")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                stream = controller;
                init.signal?.addEventListener("abort", () => {
                  try {
                    controller.close();
                  } catch {
                    /*closed*/
                  }
                });
                emit({ type: "hello", clientId: "client", ...selected });
              },
            }),
          );
        if (url.pathname.endsWith("/view"))
          return (
            options.query?.(url) ??
            Response.json({
              ok: true,
              view: view(
                0,
                "base",
                selected.rootSessionId ?? "root",
                selected.bindingGeneration,
              ),
            })
          );
        if (url.pathname.endsWith("/history") && options.history)
          return options.history(url);
        if (url.pathname.endsWith("/control"))
          return Response.json({
            ok: true,
            control: {
              runtimeEpoch: "epoch",
              sessionId: selected.rootSessionId,
              rootSessionId: selected.rootSessionId,
              bindingGeneration: selected.bindingGeneration,
              runId: "run",
              driver: "user",
            },
          });
        if (url.pathname.endsWith("/select")) {
          selected = {
            ...binding,
            rootSessionId: url.pathname.split("/")[3],
            bindingGeneration: selected.bindingGeneration + 1,
          };
          return Response.json({ ok: true, ...selected });
        }
        if (url.pathname === "/v1/sessions/index")
          return Response.json({
            ok: true,
            sessions: [
              {
                id: selected.rootSessionId,
                title: "Root",
                createdAt: "2026",
                updatedAt: "2026",
              },
            ],
          });
        if (url.pathname === "/v1/model")
          return Response.json(
            { error: { message: "metadata unavailable" } },
            { status: 503 },
          );
        if (url.pathname === "/v1/permissions")
          return Response.json({
            ok: true,
            snapshot: { ...selected, permissionRevision: 0, requests: [] },
          });
        if (url.pathname === "/v1/prompts/receipt")
          return (
            options.receipt?.(url) ??
            Response.json({
              ok: true,
              result: {
                runtimeEpoch: "epoch",
                bindingGeneration: selected.bindingGeneration,
                clientRequestId: url.searchParams.get("clientRequestId"),
                receipt: null,
              },
            })
          );
        if (url.pathname === "/v1/prompts")
          return (
            options.submit?.() ?? Promise.reject(new Error("response lost"))
          );
        if (url.pathname.endsWith("/abort")) return Response.json({ ok: true });
        if (url.pathname.endsWith("/conversation/watch")) {
          if (init.method === "DELETE") return Response.json({ ok: true });
          if (typeof init.body !== "string")
            throw new Error("Missing watch body");
          const body = JSON.parse(init.body) as { watchId: string };
          return Response.json({
            ok: true,
            result: {
              rootSessionId: "root",
              subagentId: "logical-child",
              runtimeEpoch: "epoch",
              bindingGeneration: selected.bindingGeneration,
              watchId: body.watchId,
            },
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
    },
  );
  dispose.push(() => runtime.dispose());
  return { runtime, calls, requests, emit };
}
function requireClient(runtime: OhbabyWebRuntime): UiBackendClient {
  const client = runtime.client;
  if (!client) throw new Error("Missing client");
  return client;
}
describe("browser session recovery", () => {
  it("sends the preallocated watch ID and binding for explicit pending cancellation", async () => {
    const f = fixture();
    await f.runtime.ready;
    const client = requireClient(f.runtime);
    if (
      !client.watchSubagentConversation ||
      !client.unwatchSubagentConversation
    )
      throw new Error("Missing conversation commands");
    const selection = await client.watchSubagentConversation({
      rootSessionId: "root",
      subagentId: "logical-child",
      watchId: "preallocated-watch",
    });
    expect(selection.watchId).toBe("preallocated-watch");
    await client.unwatchSubagentConversation({
      rootSessionId: "root",
      subagentId: "logical-child",
      watchId: "preallocated-watch",
    });
    const calls = f.requests.filter((request) =>
      request.url.pathname.endsWith("/conversation/watch"),
    );
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(
      JSON.parse(calls[0].body ?? "{}") as Record<string, unknown>,
    ).toMatchObject({
      watchId: "preallocated-watch",
      watchSequence: 1,
      runtimeEpoch: "epoch",
      bindingGeneration: 1,
    });
    expect(calls[1].url.searchParams.get("watchId")).toBe("preallocated-watch");
    expect(calls[1].url.searchParams.get("runtimeEpoch")).toBe("epoch");
    expect(calls[1].url.searchParams.get("bindingGeneration")).toBe("1");
  });
  it("forwards child changes and reconnect notices through the shared event subscription", async () => {
    const f = fixture();
    await f.runtime.ready;
    const received: UiEvent[] = [];
    const unsubscribe = requireClient(f.runtime).subscribeEvents((event) => {
      received.push(event);
    });
    f.emit(
      {
        type: "ui.event",
        event: {
          type: "subagent.conversation.changed",
          rootSessionId: "root",
          subagentId: "logical-child",
          watchId: "watch-1",
          change: {
            type: "session.changed",
            bindingGeneration: 1,
            version: {
              runtimeEpoch: "epoch",
              sessionId: "real-child-session",
              viewGeneration: "scope-generation",
              sessionRevision: 1,
            },
          },
        },
      },
      2,
    );
    await vi.waitFor(() => {
      expect(
        received.some(
          (event) => event.type === "subagent.conversation.changed",
        ),
      ).toBe(true);
    });
    f.emit({ type: "resync-required", maxSeqNum: 2, minSeqNum: 1 });
    await vi.waitFor(() => {
      expect(
        received.some((event) => event.type === "session.resync-required"),
      ).toBe(true);
    });
    unsubscribe();
  });

  it("joins buffered and live text appends once across the HTTP baseline and SSE boundary", async () => {
    const baseline = deferred<Response>();
    const f = fixture({ query: () => baseline.promise });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.calls.some((url) => url.pathname.endsWith("/view"))).toBe(true);
    });
    const append = {
      type: "ui.event",
      event: {
        type: "session.changed",
        version: { ...view().version, sessionRevision: 1 },
        bindingGeneration: 1,
        textAppends: [
          { messageId: "message", partId: "part", offset: 4, text: "中😀" },
        ],
      },
    } as const;
    f.emit(append, 2);
    baseline.resolve(Response.json({ ok: true, view: view() }));
    await vi.waitFor(() => {
      expect(
        f.runtime.store.getSnapshot().sessionSync.view?.session.messages[0]
          ?.parts[0],
      ).toMatchObject({ text: "base中😀" });
    });
    f.emit(append, 3);
    f.emit(
      {
        type: "ui.event",
        event: {
          ...append.event,
          version: { ...view().version, sessionRevision: 2 },
          textAppends: [
            { messageId: "message", partId: "part", offset: 7, text: "done" },
          ],
        },
      },
      4,
    );
    await vi.waitFor(() => {
      expect(
        f.runtime.store.getSnapshot().sessionSync.view?.session.messages[0]
          ?.parts[0],
      ).toMatchObject({ text: "base中😀done" });
    });
    expect(
      f.calls.filter((url) => url.pathname.endsWith("/view")),
    ).toHaveLength(1);
  });
  it("keeps the SSE reader and approvals live while a delayed baseline catches up through scoped versions", async () => {
    const baseline = deferred<Response>();
    const f = fixture({ query: () => baseline.promise });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.calls.some((url) => url.pathname.endsWith("/view"))).toBe(true);
    });
    f.emit(
      {
        type: "ui.event",
        event: {
          type: "session.changed",
          version: { ...view().version, sessionRevision: 1 },
          bindingGeneration: 1,
          messages: view(1, "latest").session.messages,
        },
      },
      0,
    );
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().permissionSync.status).toBe("ready");
    });
    expect(f.runtime.store.getSnapshot().connectionState).toBe("live");
    baseline.resolve(Response.json({ ok: true, view: view() }));
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    expect(
      f.runtime.store.getSnapshot().sessionSync.view?.session.messages[0]
        ?.parts[0],
    ).toMatchObject({ text: "latest" });
    expect(f.calls.some((url) => url.pathname === "/v1/snapshot")).toBe(false);
  });
  it("drops an old baseline after A→B→A selection and queries every hello", async () => {
    const old = deferred<Response>();
    let count = 0;
    const f = fixture({
      query: (url) =>
        ++count === 1
          ? old.promise
          : Promise.resolve(
              Response.json({
                ok: true,
                view: view(
                  2,
                  "new",
                  url.pathname.split("/")[3],
                  Number(url.searchParams.get("bindingGeneration")),
                ),
              }),
            ),
    });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(count).toBe(1);
    });
    await f.runtime.selectSession("other");
    await f.runtime.selectSession("root");
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    old.resolve(Response.json({ ok: true, view: view(0, "old") }));
    await Promise.resolve();
    expect(
      f.runtime.store.getSnapshot().sessionSync.view?.session.messages[0]
        ?.parts[0],
    ).toMatchObject({ text: "new" });
    const before = count;
    f.emit({
      type: "hello",
      clientId: "client",
      ...binding,
      bindingGeneration: 3,
    });
    await vi.waitFor(() => {
      expect(count).toBeGreaterThan(before);
    });
  });
  it("uses independent verified control to stop the exact run while the core view is pending", async () => {
    const f = fixture({ query: () => new Promise(() => undefined) });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionControl?.runId).toBe("run");
    });
    await f.runtime.abortSession("root", "run");
    expect(
      f.requests.find((request) => request.url.pathname.endsWith("/abort"))
        ?.body,
    ).toContain('"runId":"run"');
    expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("syncing");
  });
  it("queries an unknown prompt using the original id without issuing a second submission", async () => {
    const f = fixture();
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    await expect(
      requireClient(f.runtime).submitPromptAccepted("hello", {
        sessionId: "root",
        clientRequestId: "request-stable",
      }),
    ).rejects.toThrow("response lost");
    await f.runtime.retryUnknownPrompts();
    expect(
      f.calls.filter((url) => url.pathname === "/v1/prompts"),
    ).toHaveLength(1);
    expect(
      f.calls
        .filter((url) => url.pathname === "/v1/prompts/receipt")
        .map((url) => url.searchParams.get("clientRequestId")),
    ).toContain("request-stable");
  });
  it("blocks a second send while the first request is unknown", async () => {
    const f = fixture();
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    await expect(
      requireClient(f.runtime).submitPromptAccepted("secret text", {
        clientRequestId: "first",
        sessionId: "root",
      }),
    ).rejects.toThrow("response lost");
    await expect(
      requireClient(f.runtime).submitPromptAccepted("secret text", {
        clientRequestId: "second",
        sessionId: "root",
      }),
    ).rejects.toThrow("unknown");
    expect(
      f.calls.filter((url) => url.pathname === "/v1/prompts"),
    ).toHaveLength(1);
  });
  it.each([400, 500])(
    "keeps an unclassified HTTP %s result unknown because acceptance may already be durable",
    async (status) => {
      const f = fixture({
        submit: () =>
          Promise.resolve(
            Response.json(
              {
                error: { code: "Error", message: "response lost after commit" },
              },
              { status },
            ),
          ),
      });
      await f.runtime.ready;
      await vi.waitFor(() => {
        expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
      });
      await expect(
        requireClient(f.runtime).submitPromptAccepted("intent", {
          sessionId: "root",
          clientRequestId: "accepted-maybe",
        }),
      ).rejects.toThrow("response lost");
      expect(f.runtime.store.getSnapshot().unknownPromptRequests).toMatchObject(
        [{ clientRequestId: "accepted-maybe" }],
      );
      await expect(
        requireClient(f.runtime).submitPromptAccepted("intent", {
          sessionId: "root",
          clientRequestId: "second",
        }),
      ).rejects.toThrow("unknown");
      expect(
        f.calls.filter((url) => url.pathname === "/v1/prompts"),
      ).toHaveLength(1);
    },
  );
  it("clears a definite pre-accept rejection even when its HTTP status is 500", async () => {
    const f = fixture({
      submit: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "PROMPT_SUBMISSION_REJECTED",
                message: "seed failed before acceptance",
              },
            },
            { status: 500 },
          ),
        ),
    });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    await expect(
      requireClient(f.runtime).submitPromptAccepted("intent", {
        sessionId: "root",
        clientRequestId: "rejected",
      }),
    ).rejects.toThrow("seed failed");
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
  });
  it("does not forget a submission while its POST is still in flight", async () => {
    const pending = deferred<Response>();
    const f = fixture({ submit: () => pending.promise });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    const sending = requireClient(f.runtime).submitPromptAccepted("intent", {
      sessionId: "root",
      clientRequestId: "in-flight",
    });
    f.runtime.forgetUnknownPrompt("in-flight");
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toMatchObject([
      { clientRequestId: "in-flight", submitting: true },
    ]);
    const rejected = expect(sending).rejects.toThrow("response interrupted");
    pending.resolve(
      Response.json(
        { error: { message: "response interrupted" } },
        { status: 502 },
      ),
    );
    await rejected;
    f.runtime.forgetUnknownPrompt("in-flight");
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
  });
  it("forgets only the selected unknown request without resending it and permits a new intent", async () => {
    const f = fixture();
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    await expect(
      requireClient(f.runtime).submitPromptAccepted("first intent", {
        clientRequestId: "first",
        sessionId: "root",
      }),
    ).rejects.toThrow("response lost");
    await f.runtime.retryUnknownPrompts();
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toHaveLength(1);
    f.runtime.forgetUnknownPrompt("unrelated");
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toHaveLength(1);
    f.runtime.forgetUnknownPrompt("first");
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
    expect(
      f.calls.filter((url) => url.pathname === "/v1/prompts"),
    ).toHaveLength(1);
    await expect(
      requireClient(f.runtime).submitPromptAccepted("new intent", {
        clientRequestId: "second",
        sessionId: "root",
      }),
    ).rejects.toThrow("response lost");
    expect(
      f.calls.filter((url) => url.pathname === "/v1/prompts"),
    ).toHaveLength(2);
  });
  it("recovers a new-session unknown receipt after refresh without persisting text or changing selection", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const first = fixture({ initialBinding: { rootSessionId: null } });
    await first.runtime.ready;
    await expect(
      requireClient(first.runtime).submitPromptAccepted("private prompt", {
        clientRequestId: "new-request",
      }),
    ).rejects.toThrow("response lost");
    expect(
      [...values.values()].some((value) => value.includes("private prompt")),
    ).toBe(false);
    await first.runtime.dispose();
    const next = fixture({
      receipt: (url) =>
        Promise.resolve(
          Response.json({
            ok: true,
            result: {
              runtimeEpoch: "epoch",
              bindingGeneration: 1,
              clientRequestId: url.searchParams.get("clientRequestId"),
              receipt: {
                clientRequestId: "new-request",
                promptId: "prompt",
                sessionId: "original-new-root",
                userMessageId: "user",
                createdAt: "2026",
                status: "queued",
              },
            },
          }),
        ),
    });
    await next.runtime.ready;
    await vi.waitFor(() => {
      expect(next.runtime.store.getSnapshot().unknownPromptRequests).toEqual(
        [],
      );
    });
    const lookup = next.calls.find(
      (url) => url.pathname === "/v1/prompts/receipt",
    );
    expect(lookup?.searchParams.has("sessionId")).toBe(false);
    expect(next.calls.some((url) => url.pathname === "/v1/prompts")).toBe(
      false,
    );
    expect(await requireClient(next.runtime).getSelectedSessionId()).toBe(
      "root",
    );
  });
  it("marks persisted requests from another runtime as unknown without looking up or resubmitting", async () => {
    const values = new Map([
      [
        "ohbaby.web.unknown-prompts.v1:%2Frepo:old",
        JSON.stringify({
          directory: "/repo",
          clientRequestId: "old",
          runtimeEpoch: "old-epoch",
          sessionId: "root",
          status: "unknown",
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const f = fixture({
      command: (body) => {
        const invocation = JSON.parse(body) as {
          clientInvocationId: string;
          clientRequestId: string;
        };
        return Response.json({
          ok: true,
          status: "completed",
          commandRunId: "new-skill",
          clientInvocationId: invocation.clientInvocationId,
          outputCount: 0,
          eventCount: 0,
          promptReceipt: {
            clientRequestId: invocation.clientRequestId,
            promptId: "new-prompt",
            sessionId: "root",
            userMessageId: "new-message",
            createdAt: "2026-09-29T00:00:00Z",
            status: "queued",
          },
        });
      },
    });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(
        f.runtime.store.getSnapshot().unknownPromptRequests[0]?.status,
      ).toBe("epoch-changed");
    });
    expect(f.calls.some((url) => url.pathname.startsWith("/v1/prompts"))).toBe(
      false,
    );
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    const invocation = {
      clientInvocationId: "new-skill",
      clientRequestId: "new-skill-intent",
      commandId: "skill.review",
      path: ["review"],
      raw: "/review",
      rawArgs: "",
      argv: [],
      sessionId: "root",
      surface: "tui",
    };
    await expect(
      requireClient(f.runtime).executeCommand(invocation),
    ).resolves.toMatchObject({
      status: "completed",
      promptReceipt: { clientRequestId: "new-skill-intent" },
    });
    expect(f.runtime.store.getSnapshot().unknownPromptRequests).toMatchObject([
      { clientRequestId: "old", status: "epoch-changed" },
    ]);
    await expect(
      requireClient(f.runtime).executeCommand({
        ...invocation,
        clientInvocationId: "old-intent",
        clientRequestId: "old",
      }),
    ).rejects.toThrow("query its receipt");
    const commands = f.requests.filter(
      (request) =>
        request.url.pathname === "/v1/commands" && request.method === "POST",
    );
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]?.body ?? "{}")).toMatchObject({
      clientRequestId: "new-skill-intent",
    });
    await expect(
      requireClient(f.runtime).submitPromptAccepted("new epoch intent", {
        clientRequestId: "new-epoch-request",
        sessionId: "root",
      }),
    ).rejects.toThrow("response lost");
    f.runtime.forgetUnknownPrompt("old");
    expect(
      [...values.values()].some((value) =>
        value.includes('"clientRequestId":"old"'),
      ),
    ).toBe(false);
  });
  it("ignores history from the previous binding and keeps paging errors separate from chat readiness", async () => {
    const pending = deferred<Response>();
    let historyRequests = 0;
    const f = fixture({
      query: (url) =>
        Promise.resolve(
          Response.json({
            ok: true,
            view: {
              ...view(
                0,
                "base",
                url.pathname.split("/")[3],
                Number(url.searchParams.get("bindingGeneration")),
              ),
              history: { hasMore: true, before: "cursor" },
            },
          }),
        ),
      history: async () =>
        ++historyRequests === 1
          ? pending.promise
          : Response.json(
              { error: { message: "history offline" } },
              { status: 503 },
            ),
    });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    const loading = f.runtime.loadEarlierHistory();
    await f.runtime.selectSession("other");
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    pending.resolve(
      Response.json({
        ok: true,
        history: {
          version: view().version,
          bindingGeneration: 1,
          messages: [
            { id: "old-page", role: "user", createdAt: "2025", parts: [] },
          ],
          prompts: [],
          reasoningMissing: false,
          hasMore: false,
        },
      }),
    );
    await loading;
    expect(
      f.runtime.store
        .getSnapshot()
        .view.snapshot?.sessions.flatMap((session) => session.messages)
        .some((message) => message.id === "old-page"),
    ).toBe(false);
    await f.runtime.loadEarlierHistory();
    expect(f.runtime.store.getSnapshot().historyState).toBe("error");
    expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    expect(f.runtime.store.getSnapshot().connectionState).toBe("live");
  });
  it("reports an unsupported recovery capability without falling back to snapshots", async () => {
    const f = fixture({ initialBinding: { sessionRecoveryVersion: 0 } });
    await f.runtime.ready;
    expect(f.runtime.store.getSnapshot().sessionSync).toMatchObject({
      status: "error",
      error: "Server does not support session recovery version 1",
    });
    expect(
      f.calls.some(
        (url) =>
          url.pathname.endsWith("/snapshot") || url.pathname.endsWith("/view"),
      ),
    ).toBe(false);
    expect(f.runtime.store.getSnapshot().connectionState).toBe("live");
  });
  it("restarts an invalidated history cache from the current view boundary", async () => {
    const cursors: string[] = [];
    const f = fixture({
      query: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            view: { ...view(), history: { hasMore: true, before: "recent" } },
          }),
        ),
      history: (url) => {
        cursors.push(url.searchParams.get("before") ?? "");
        return Promise.resolve(
          Response.json({
            ok: true,
            history: {
              version: {
                ...view().version,
                sessionRevision: cursors.length - 1,
              },
              bindingGeneration: 1,
              messages: [
                { id: "older", role: "user", createdAt: "2025", parts: [] },
              ],
              prompts: [],
              reasoningMissing: false,
              hasMore: true,
              before: "deep",
            },
          }),
        );
      },
    });
    await f.runtime.ready;
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    await f.runtime.loadEarlierHistory();
    f.emit({
      type: "ui.event",
      event: {
        type: "session.changed",
        version: { ...view().version, sessionRevision: 1 },
        bindingGeneration: 1,
        historyInvalidated: true,
      },
    });
    await vi.waitFor(() => {
      expect(f.runtime.store.getSnapshot().historyStale).toBe(true);
    });
    await f.runtime.loadEarlierHistory();
    expect(cursors).toEqual(["recent", "recent"]);
  });
});
