import { describe, expect, it } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import { createOhbabyWebRuntime } from "./client.js";

const encoder = new TextEncoder();

function directoryFromBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected a JSON string body");
  }
  const value: unknown = JSON.parse(body);
  if (
    typeof value !== "object" ||
    value === null ||
    !("directory" in value) ||
    typeof value.directory !== "string"
  ) {
    throw new Error("Expected a directory body");
  }
  return value.directory;
}

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
              { available: true, directory: "/repo-a", lastOpenedAt: 2, loaded: true, position: 0 },
              { available: true, directory: "/repo-b", lastOpenedAt: 1, loaded: false, position: 1 },
            ],
          }),
        );
      }
      if (request.url.endsWith("/v1/scopes/open")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scope: {
              available: true,
              directory: directoryFromBody(init.body),
              lastOpenedAt: 1,
              loaded: false,
              position: 1,
            },
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
      if (request.url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
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
        { available: true, directory: "/repo-a", lastOpenedAt: 2, loaded: true, position: 0 },
        { available: true, directory: "/repo-b", lastOpenedAt: 1, loaded: false, position: 1 },
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
    ).toEqual(["/v1/clients", "/v1/events", "/v1/snapshot", "/v1/model"]);
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
      if (request.url.endsWith("/v1/scopes/open")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scope: {
              available: true,
              directory: directoryFromBody(init.body),
              lastOpenedAt: 1,
              loaded: false,
              position: 1,
            },
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
      if (request.url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
      }
      if (request.url.endsWith("/v1/scopes")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scopes: [
              { available: true, directory: "/repo-a", lastOpenedAt: 2, loaded: true, position: 0 },
              { available: true, directory: "/repo-b", lastOpenedAt: 1, loaded: false, position: 1 },
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
