import { describe, expect, it, vi } from "vitest";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";
import { createRemoteUiBackendClient } from "./client.js";

function emptySnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

const encoder = new TextEncoder();

function notice(id: string): UiEvent {
  return {
    notice: {
      createdAt: "2026-06-12T00:00:00.000Z",
      id,
      level: "info",
      message: id,
      title: id,
    },
    type: "notice.emitted",
  };
}

function sseFrame(data: unknown, id?: number): string {
  const idLine = id === undefined ? "" : `id: ${String(id)}\n`;
  const eventType =
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof data.type === "string"
      ? data.type
      : "message";
  return `${idLine}event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  );
}

function requireStringBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected JSON string request body");
  }
  return init.body;
}

describe("createRemoteUiBackendClient", () => {
  it("rejects an old daemon's empty command completion without retrying", async () => {
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(requireStringBody(init)) as { id: string };
      return Promise.resolve(Response.json({ id: body.id, ok: true }));
    });
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      fetch: fetcher,
      port: 4096,
      startupIntent: undefined,
    });
    await expect(
      client.executeCommand({
        clientInvocationId: "i",
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        argv: [],
        surface: "tui",
      }),
    ).rejects.toThrow("unconfirmed");
    expect(
      fetcher.mock.calls.filter(
        (call) =>
          (JSON.parse(requireStringBody(call[1])) as { method: string })
            .method === "executeCommand",
      ),
    ).toHaveLength(1);
    await client.dispose();
  });

  it("throws remote structured errors with their stable fields intact", async () => {
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "QUEUE_FULL",
                limit: 100,
                message: "queue full",
                retryable: true,
                source: "scheduler",
              },
              id: "rpc_failure",
              ok: false,
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        ),
      port: 4096,
      startupIntent: undefined,
    });

    await expect(client.submitPromptAccepted("overflow")).rejects.toMatchObject(
      {
        code: "QUEUE_FULL",
        limit: 100,
        retryable: true,
        source: "scheduler",
      },
    );
  });

  it("uses additive prompt admission and mutation RPC methods", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(requireStringBody(init)) as {
          readonly id: string;
          readonly method: string;
        };
        methods.push(body.method);
        const prompt = {
          clientRequestId: "request_1",
          createdAt: "2026-06-12T00:00:00.000Z",
          promptId: "prompt_1",
          scopeKey: "/repo-a",
          sessionId: "session_1",
          status: body.method === "cancelQueuedPrompt" ? "cancelled" : "queued",
          text: "edited",
          updatedAt: "2026-06-12T00:00:01.000Z",
          userMessageId: "message_1",
        } as const;
        const result =
          body.method === "submitPromptAccepted"
            ? {
                createdAt: prompt.createdAt,
                clientRequestId: prompt.clientRequestId,
                promptId: prompt.promptId,
                sessionId: prompt.sessionId,
                status: "queued",
                userMessageId: prompt.userMessageId,
              }
            : body.method === "acquirePromptEditLease" ||
                body.method === "renewPromptEditLease"
              ? {
                  editLeaseId: "lease_1",
                  expiresAt: "2026-06-12T00:01:00.000Z",
                  ownerClientId: "client_1",
                  prompt,
                }
              : body.method === "waitForPrompt"
                ? { prompt: { ...prompt, status: "cancelled" } }
                : body.method === "initializeClient"
                  ? undefined
                  : prompt;
        return Promise.resolve(
          new Response(JSON.stringify({ id: body.id, ok: true, result }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      fetch: fetchImpl,
      port: 4096,
    });

    const receipt = await client.submitPromptAccepted("first", {
      clientRequestId: "request_1",
      sessionId: "session_1",
    });
    const lease = await client.acquirePromptEditLease({
      promptId: receipt.promptId,
    });
    await client.renewPromptEditLease({
      editLeaseId: lease.editLeaseId,
      promptId: receipt.promptId,
    });
    await client.releasePromptEditLease({
      editLeaseId: lease.editLeaseId,
      promptId: receipt.promptId,
    });
    await client.acquirePromptEditLease({
      promptId: receipt.promptId,
    });
    await client.editQueuedPrompt({
      editLeaseId: "lease_1",
      promptId: receipt.promptId,
      text: "edited",
    });
    await client.resubmitRetainedPrompt({
      editLeaseId: "lease_1",
      promptId: receipt.promptId,
      text: "send retained",
      operationId: "resubmit_1",
    });
    await client.cancelQueuedPrompt({
      promptId: receipt.promptId,
    });
    await expect(client.waitForPrompt(receipt.promptId)).resolves.toMatchObject(
      {
        prompt: { promptId: "prompt_1", status: "cancelled" },
      },
    );
    await expect(
      client.submitPromptAndWait("composed", {
        clientRequestId: "request_2",
        sessionId: "session_1",
      }),
    ).resolves.toMatchObject({
      prompt: { promptId: "prompt_1", status: "cancelled" },
    });
    expect(methods).toEqual([
      "initializeClient",
      "submitPromptAccepted",
      "acquirePromptEditLease",
      "renewPromptEditLease",
      "releasePromptEditLease",
      "acquirePromptEditLease",
      "editQueuedPrompt",
      "resubmitRetainedPrompt",
      "cancelQueuedPrompt",
      "waitForPrompt",
      "submitPromptAccepted",
      "waitForPrompt",
    ]);
  });

  it("aborts only the wait step after submitPromptAndWait is accepted", async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const requestSignals = new Map<string, AbortSignal | null | undefined>();
    let resolveWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      resolveWaitStarted = resolve;
    });
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(requireStringBody(init)) as {
          readonly id: string;
          readonly method: string;
        };
        methods.push(body.method);
        requestSignals.set(body.method, init?.signal);
        if (body.method === "waitForPrompt") {
          resolveWaitStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            const rejectAbort = (): void => {
              reject(new DOMException("wait aborted", "AbortError"));
            };
            if (init?.signal?.aborted === true) {
              rejectAbort();
              return;
            }
            init?.signal?.addEventListener("abort", rejectAbort, {
              once: true,
            });
          });
        }
        const result =
          body.method === "submitPromptAccepted"
            ? {
                clientRequestId: "request_1",
                createdAt: "2026-06-12T00:00:00.000Z",
                promptId: "prompt_1",
                sessionId: "session_1",
                status: "queued",
                userMessageId: "message_1",
              }
            : undefined;
        return Promise.resolve(
          new Response(JSON.stringify({ id: body.id, ok: true, result }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      fetch: fetchImpl,
      port: 4096,
    });

    const completion = client.submitPromptAndWait("accepted first", {
      clientRequestId: "request_1",
      sessionId: "session_1",
      signal: controller.signal,
    });
    await waitStarted;

    expect(methods).toEqual([
      "initializeClient",
      "submitPromptAccepted",
      "waitForPrompt",
    ]);
    expect(requestSignals.get("submitPromptAccepted")).toBeUndefined();
    expect(requestSignals.get("waitForPrompt")).toBe(controller.signal);

    controller.abort();
    await expect(completion).rejects.toThrow(
      "Daemon connection failed while running waitForPrompt",
    );
  });

  it("sends JSON-RPC requests with auth and returns snapshots", async () => {
    const requests: {
      readonly body: Record<string, unknown>;
      readonly headers: Headers;
      readonly method: string | undefined;
      readonly url: string;
    }[] = [];
    const fetchImpl = vi.fn(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected JSON string request body");
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        requests.push({
          body,
          headers: new Headers(init.headers),
          method: init.method,
          url: requestUrl,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: body.id,
              ok: true,
              result: body.method === "getSnapshot" ? emptySnapshot() : null,
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      authToken: "token_1",
      clientId: "client_1",
      directory: "/repo-a",
      fetch: fetchImpl,
      port: 4096,
    });

    await expect(client.getSnapshot()).resolves.toEqual(emptySnapshot());

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      body: {
        clientId: "client_1",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      },
      method: "POST",
      url: "http://127.0.0.1:4096/api/rpc",
    });
    expect(requests[1]).toMatchObject({
      body: {
        clientId: "client_1",
        method: "getSnapshot",
        params: [],
      },
      method: "POST",
      url: "http://127.0.0.1:4096/api/rpc",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token_1");
    expect(requests[0]?.headers.get("x-ohbaby-directory")).toBe("%2Frepo-a");
    expect(requests[0]?.headers.get("x-ohbaby-directory-encoding")).toBe(
      "percent-utf8",
    );
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer token_1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("encodes Unicode workspace directories before sending RPC headers", async () => {
    const unicodeDirectory =
      "D:\\Upan\\books\\learning materials\\李笑来作品集";
    const headers: Headers[] = [];
    const fetchImpl = vi.fn(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        headers.push(request.headers);
        const body = JSON.parse(requireStringBody(init)) as {
          readonly id: string;
          readonly method: string;
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: body.id,
              ok: true,
              result: body.method === "getSnapshot" ? emptySnapshot() : null,
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      clientId: "unicode_client",
      directory: unicodeDirectory,
      fetch: fetchImpl,
      port: 4096,
    });

    await expect(client.getSnapshot()).resolves.toEqual(emptySnapshot());

    expect(headers).toHaveLength(2);
    for (const requestHeaders of headers) {
      expect(requestHeaders.get("x-ohbaby-directory")).toBe(
        encodeURIComponent(unicodeDirectory),
      );
      expect(requestHeaders.get("x-ohbaby-directory-encoding")).toBe(
        "percent-utf8",
      );
    }
    await client.dispose();
  });

  it("reconnects SSE streams with the last received event id", async () => {
    const eventRequestHeaders: Headers[] = [];
    let eventRequests = 0;
    const fetchImpl = vi.fn(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (requestUrl.includes("/api/rpc")) {
          const body = JSON.parse(requireStringBody(init)) as {
            readonly id: string;
            readonly method: string;
          };
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: body.id,
                ok: true,
                result: body.method === "getSnapshot" ? emptySnapshot() : null,
              }),
              {
                headers: { "content-type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        eventRequests += 1;
        eventRequestHeaders.push(new Headers(init?.headers));
        if (eventRequests === 1) {
          return Promise.resolve(
            sseResponse([
              sseFrame({
                clientId: "client_1",
                type: "hello",
                permissionEpoch: "test-epoch",
                rootSessionId: null,
                bindingGeneration: 1,
              }),
              sseFrame({ event: notice("notice_1"), type: "ui.event" }, 1),
            ]),
          );
        }
        return Promise.resolve(
          sseResponse([
            sseFrame({ event: notice("notice_2"), type: "ui.event" }, 2),
          ]),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      directory: "/repo-a",
      fetch: fetchImpl,
      port: 4096,
    });
    const events: UiEvent[] = [];

    client.subscribeEvents((event) => {
      if (event.type === "notice.emitted") events.push(event);
    });
    await vi.waitUntil(() => events.length === 2, { timeout: 2500 });
    await client.dispose();

    expect(events).toEqual([notice("notice_1"), notice("notice_2")]);
    expect(eventRequestHeaders[0]?.get("last-event-id")).toBeNull();
    expect(eventRequestHeaders[0]?.get("x-ohbaby-directory")).toBe("%2Frepo-a");
    expect(eventRequestHeaders[0]?.get("x-ohbaby-directory-encoding")).toBe(
      "percent-utf8",
    );
    expect(eventRequestHeaders[1]?.get("last-event-id")).toBe("1");
  });

  it("requests source resync without querying a snapshot when replay is stale", async () => {
    const methods: string[] = [];
    const binding = {
      permissionEpoch: "epoch",
      runtimeEpoch: "epoch",
      sessionRecoveryVersion: 1,
      rootSessionId: "root",
      bindingGeneration: 1,
    };
    const client = createRemoteUiBackendClient({
      port: 4096,
      fetch: (url, init) => {
        const address =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (address.includes("/api/rpc")) {
          const body = JSON.parse(requireStringBody(init)) as {
            id: string;
            method: string;
          };
          methods.push(body.method);
          return Promise.resolve(
            new Response(
              JSON.stringify({ id: body.id, ok: true, result: binding }),
            ),
          );
        }
        return Promise.resolve(
          sseResponse([
            sseFrame({ type: "hello", clientId: "client_1", ...binding }),
            sseFrame({ type: "resync-required", minSeqNum: 2, maxSeqNum: 3 }),
          ]),
        );
      },
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });
    await vi.waitUntil(
      () =>
        events.filter(
          (event) =>
            event.type === "session.resync-required" && !event.disconnected,
        ).length >= 2,
    );
    await client.dispose();
    expect(events.some((event) => event.type === "snapshot.replaced")).toBe(
      false,
    );
    expect(methods).toEqual(["initializeClient"]);
  });
});

it("keeps permission events and reconnect recovery independent of failed or pending full snapshots", async () => {
  const binding = {
    permissionEpoch: "epoch",
    rootSessionId: "root",
    bindingGeneration: 1,
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let connections = 0;
  let releaseQuery!: () => void;
  const queryBarrier = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  const client = createRemoteUiBackendClient({
    port: 1,
    clientId: "client_1",
    fetch: async (input, init) => {
      if (
        (input instanceof Request ? input.url : input.toString()).includes(
          "/api/events",
        )
      ) {
        connections += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value): void {
              controller = value;
              value.enqueue(
                encoder.encode(
                  sseFrame({ type: "hello", clientId: "client_1", ...binding }),
                ),
              );
            },
          }),
        );
      }
      const rpc = JSON.parse(requireStringBody(init)) as {
        id: string;
        method: string;
      };
      if (rpc.method === "initializeClient")
        return Response.json({ id: rpc.id, ok: true, result: binding });
      if (rpc.method === "getPermissionSnapshot") {
        await queryBarrier;
        return Response.json({
          id: rpc.id,
          ok: true,
          result: { ...binding, permissionRevision: 0, requests: [] },
        });
      }
      return Response.json({
        id: rpc.id,
        ok: false,
        error: { message: "history unavailable" },
      });
    },
  });
  const received: import("ohbaby-sdk").UiPermissionEvent[] = [];
  const stop = client.subscribePermissionEvents((event) => {
    received.push(event);
  });
  try {
    await vi.waitUntil(() =>
      received.some((event) => event.type === "permission.resync-required"),
    );
    controller.enqueue(
      encoder.encode(
        sseFrame({ type: "resync-required", minSeqNum: 1, maxSeqNum: 100 }),
      ),
    );
    controller.enqueue(
      encoder.encode(
        sseFrame(
          {
            type: "ui.event",
            event: {
              type: "permission.resolved",
              ...binding,
              permissionRevision: 1,
              requestId: "old",
              sessionId: "child",
              reason: "aborted",
            },
          },
          2,
        ),
      ),
    );
    await vi.waitUntil(() =>
      received.some((event) => event.type === "permission.resolved"),
    );
    controller.close();
    await vi.waitUntil(() => connections === 2, { timeout: 2500 });
    await vi.waitUntil(() =>
      received.some(
        (event) =>
          event.type === "permission.resync-required" &&
          event.connectionGeneration === 2,
      ),
    );
    expect(await client.getSelectedSessionId()).toBe("root");
  } finally {
    releaseQuery();
    stop();
    await client.dispose();
  }
});

it.each(["selectSession", "createSession", "submitPromptAccepted"] as const)(
  "ignores a late %s binding after a newer hello",
  async (method) => {
    const binding = {
      permissionEpoch: "epoch",
      rootSessionId: "root",
      bindingGeneration: 1,
    };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let finish: (() => void) | undefined;
    let queries = 0;
    const received: import("ohbaby-sdk").UiPermissionEvent[] = [];
    const client = createRemoteUiBackendClient({
      port: 1,
      clientId: "client_1",
      fetch: async (input, init) => {
        if (
          (input instanceof Request ? input.url : input.toString()).includes(
            "/api/events",
          )
        ) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(value): void {
                controller = value;
                value.enqueue(
                  encoder.encode(
                    sseFrame({
                      type: "hello",
                      clientId: "client_1",
                      ...binding,
                    }),
                  ),
                );
              },
            }),
          );
        }
        const rpc = JSON.parse(requireStringBody(init)) as {
          id: string;
          method: string;
        };
        if (rpc.method === "initializeClient")
          return Response.json({ id: rpc.id, ok: true, result: binding });
        if (rpc.method === "getPermissionSnapshot") queries += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return Response.json({
          id: rpc.id,
          ok: true,
          result: {
            ...binding,
            rootSessionId: "old-root",
            bindingGeneration: 2,
            session: { id: "old-root" },
            promptId: "prompt",
          },
        });
      },
    });
    const stop = client.subscribePermissionEvents((event) => {
      received.push(event);
    });
    try {
      await vi.waitUntil(() => received.length === 1);
      const pending =
        method === "selectSession"
          ? client.selectSession("old-root")
          : method === "createSession"
            ? client.createSession()
            : client.submitPromptAccepted("prompt");
      await vi.waitUntil(() => finish !== undefined);
      controller.enqueue(
        encoder.encode(
          sseFrame({
            type: "hello",
            clientId: "client_1",
            ...binding,
            rootSessionId: "new-root",
            bindingGeneration: 3,
          }),
        ),
      );
      await vi.waitUntil(() => received.length === 2);
      finish?.();
      await pending;
      expect(await client.getSelectedSessionId()).toBe("new-root");
      expect(queries).toBe(0);
    } finally {
      finish?.();
      stop();
      await client.dispose();
    }
  },
);

it("releases failed initialization and retries with the same client and startup intent", async () => {
  const calls: { clientId: string; method: string; params: unknown[] }[] = [];
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(requireStringBody(init)) as {
      id: string;
      clientId: string;
      method: string;
      params: unknown[];
    };
    calls.push(body);
    if (calls.length === 1)
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    return Promise.resolve(
      Response.json({
        id: body.id,
        ok: true,
        result:
          body.method === "initializeClient"
            ? {
                permissionEpoch: "epoch",
                runtimeEpoch: "epoch",
                rootSessionId: null,
                bindingGeneration: 1,
                sessionRecoveryVersion: 1,
              }
            : [],
      }),
    );
  });
  const client = createRemoteUiBackendClient({
    clientId: "same-client",
    fetch: fetcher,
    port: 4096,
    startupIntent: { startupSessionMode: { type: "fresh" } },
  });
  await expect(client.getSessionIndex()).rejects.toThrow("503");
  await expect(client.getSessionIndex()).resolves.toEqual([]);
  const bootstrap = calls.filter((call) => call.method === "initializeClient");
  expect(bootstrap).toHaveLength(2);
  expect(bootstrap[0].clientId).toBe(bootstrap[1].clientId);
  expect(bootstrap[0].params).toEqual(bootstrap[1].params);
  await client.dispose();
});

it("backs off persistent bootstrap refusal in the single SSE loop with stable startup identity", async () => {
  vi.useFakeTimers();
  const calls: { clientId: string; params: unknown[] }[] = [];
  const client = createRemoteUiBackendClient({
    clientId: "refused-client",
    port: 4096,
    startupIntent: { startupSessionMode: { type: "fresh" } },
    fetch: (_url, init) => {
      calls.push(
        JSON.parse(requireStringBody(init)) as {
          clientId: string;
          params: unknown[];
        },
      );
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    },
  });
  const unsubscribe = client.subscribeEvents(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    for (const [index, delay] of [
      1000, 2000, 5000, 10000, 30000, 30000,
    ].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(calls).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(index + 2);
    }
    expect(new Set(calls.map((call) => call.clientId))).toEqual(
      new Set(["refused-client"]),
    );
    expect(
      calls.every(
        (call) =>
          JSON.stringify(call.params) === JSON.stringify(calls[0]?.params),
      ),
    ).toBe(true);
  } finally {
    unsubscribe();
    await client.dispose();
    vi.useRealTimers();
  }
});

it("keeps reconnect backoff across short-lived hello connections", async () => {
  vi.useFakeTimers();
  let connections = 0;
  const client = createRemoteUiBackendClient({
    clientId: "hello-client",
    port: 4096,
    fetch: () => {
      connections += 1;
      return Promise.resolve(
        sseResponse([
          sseFrame({
            type: "hello",
            clientId: "hello-client",
            permissionEpoch: "epoch",
            rootSessionId: null,
            bindingGeneration: 1,
          }),
        ]),
      );
    },
  });
  const stop = client.subscribeEvents(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(connections).toBe(1);
    for (const [index, wait] of [1000, 2000, 5000, 10000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(connections).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toBe(index + 2);
    }
  } finally {
    stop();
    await client.dispose();
    vi.useRealTimers();
  }
});
