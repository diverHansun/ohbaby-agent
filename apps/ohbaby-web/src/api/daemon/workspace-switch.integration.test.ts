import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import { createOhbabyWebRuntime } from "./client.js";

const encoder = new TextEncoder();

function emptySnapshot(title: string): UiSnapshot {
  return {
    activeSessionId: null,
    permission: { level: "default", mode: "auto", sessionRules: [] },
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: "2026-07-11T00:00:00.000Z",
        id: `session-${title}`,
        messages: [],
        title,
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    status: { kind: "idle" },
  };
}

describe("ohbaby web workspace switching", () => {
  it("closes the old SSE generation and rebinds HTTP and SSE to the new directory", async () => {
    const requests: { clientId?: string; directory?: string; url: string }[] =
      [];
    const abortedDirectories: string[] = [];
    const fetchImpl: typeof fetch = (input, init = {}) => {
      const request = new Request(input, init);
      const directory = request.headers.get("x-ohbaby-directory") ?? undefined;
      const clientId = request.headers.get("x-ohbaby-client-id") ?? undefined;
      requests.push({ clientId, directory, url: request.url });
      if (request.url.endsWith("/v1/scopes")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scopes: [
              { directory: "/repo-a", loaded: true },
              { directory: "/repo-b", loaded: false },
            ],
          }),
        );
      }
      if (request.url.endsWith("/v1/clients")) {
        return Promise.resolve(Response.json({ clientId, ok: true }));
      }
      if (request.url.endsWith("/v1/snapshot")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: emptySnapshot(directory === "/repo-b" ? "B" : "A"),
          }),
        );
      }
      if (request.url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ clientId, type: "hello" })}\n\n`,
                  ),
                );
                request.signal.addEventListener(
                  "abort",
                  () => {
                    if (directory) {
                      abortedDirectories.push(directory);
                    }
                    controller.close();
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client-a",
        directory: "/repo-a",
        token: "token",
      },
      { fetch: fetchImpl },
    );

    await runtime.ready;
    await runtime.refreshWorkspaces();
    expect(runtime.getWorkspaceSnapshot()).toEqual({
      scopes: [
        { directory: "/repo-a", loaded: true },
        { directory: "/repo-b", loaded: false },
      ],
      selectedDirectory: "/repo-a",
    });

    await runtime.switchWorkspace("/repo-b");

    expect(abortedDirectories).toEqual(["/repo-a"]);
    expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/repo-b");
    expect(runtime.store.getSnapshot().view.snapshot?.sessions[0]?.title).toBe(
      "B",
    );
    const repoBRequests = requests.filter(
      (request) => request.directory === "/repo-b",
    );
    expect(
      repoBRequests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/v1/clients", "/v1/events", "/v1/snapshot"]);
    expect(new Set(repoBRequests.map((request) => request.clientId)).size).toBe(
      1,
    );
    expect(repoBRequests[0]?.clientId).not.toBe("client-a");

    await runtime.client.close();
  });

  it("restores the previous workspace when the target fails closed", async () => {
    const clientDirectories: string[] = [];
    const fetchImpl: typeof fetch = (input, init = {}) => {
      const request = new Request(input, init);
      const directory = request.headers.get("x-ohbaby-directory") ?? "";
      if (request.url.endsWith("/v1/clients")) {
        clientDirectories.push(directory);
        if (directory === "/repo-b") {
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "directory-unavailable",
                  message: "workspace disappeared",
                },
                ok: false,
              },
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (request.url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "hello" })}\n\n`,
                  ),
                );
                request.signal.addEventListener(
                  "abort",
                  () => {
                    controller.close();
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (request.url.endsWith("/v1/snapshot")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: emptySnapshot("A"),
          }),
        );
      }
      if (request.url.endsWith("/v1/scopes")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scopes: [
              { directory: "/repo-a", loaded: true },
              { directory: "/repo-b", loaded: false },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client-a",
        directory: "/repo-a",
        token: "token",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;
    await runtime.refreshWorkspaces();

    await expect(runtime.switchWorkspace("/repo-b")).rejects.toThrow(
      "workspace disappeared",
    );

    expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/repo-a");
    expect(runtime.store.getSnapshot().view.snapshot?.sessions[0]?.title).toBe(
      "A",
    );
    expect(clientDirectories).toEqual(["/repo-a", "/repo-b", "/repo-a"]);
    await runtime.client.close();
  });
});
