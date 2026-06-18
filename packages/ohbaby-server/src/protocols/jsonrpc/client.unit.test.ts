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
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
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
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer token_1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reconnects SSE streams with the last received event id", async () => {
    const eventRequestHeaders: Headers[] = [];
    let eventRequests = 0;
    const fetchImpl = vi.fn(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const requestUrl =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
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
              sseFrame({ clientId: "client_1", type: "hello" }),
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
      fetch: fetchImpl,
      port: 4096,
    });
    const events: UiEvent[] = [];

    client.subscribeEvents((event) => {
      events.push(event);
    });
    await vi.waitUntil(() => events.length === 2, { timeout: 500 });
    await client.dispose();

    expect(events).toEqual([notice("notice_1"), notice("notice_2")]);
    expect(eventRequestHeaders[0]?.get("last-event-id")).toBeNull();
    expect(eventRequestHeaders[1]?.get("last-event-id")).toBe("1");
  });

  it("emits a snapshot replacement when the SSE replay window is stale", async () => {
    const snapshot = {
      ...emptySnapshot(),
      activeSessionId: "session_1",
      sessions: [
        {
          createdAt: "2026-06-12T00:00:00.000Z",
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: "2026-06-12T00:00:00.000Z",
        },
      ],
    } satisfies UiSnapshot;
    const rpcMethods: string[] = [];
    const fetchImpl = vi.fn(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const requestUrl =
          typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.includes("/api/rpc")) {
          const body = JSON.parse(requireStringBody(init)) as {
            readonly id: string;
            readonly method: string;
          };
          rpcMethods.push(body.method);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: body.id,
                ok: true,
                result: body.method === "getSnapshot" ? snapshot : null,
              }),
              {
                headers: { "content-type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        return Promise.resolve(
          sseResponse([
            sseFrame({
              maxSeqNum: 3,
              minSeqNum: 2,
              type: "resync-required",
            }),
          ]),
        );
      },
    );
    const client = createRemoteUiBackendClient({
      clientId: "client_1",
      fetch: fetchImpl,
      port: 4096,
    });
    const events: UiEvent[] = [];

    client.subscribeEvents((event) => {
      events.push(event);
    });
    await vi.waitUntil(() => events.length === 1, { timeout: 500 });
    await client.dispose();

    expect(events).toEqual([{ snapshot, type: "snapshot.replaced" }]);
    expect(rpcMethods).toEqual(["initializeClient", "getSnapshot"]);
  });
});
