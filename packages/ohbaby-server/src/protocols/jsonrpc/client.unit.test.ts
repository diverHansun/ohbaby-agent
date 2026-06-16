import { describe, expect, it, vi } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
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
});
