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

function directoryFromScopeHeader(request: Request): string {
  const directory = request.headers.get("x-ohbaby-directory") ?? "";
  return request.headers.get("x-ohbaby-directory-encoding") === "percent-utf8"
    ? decodeURIComponent(directory)
    : directory;
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
      const directory = request.headers.has("x-ohbaby-directory")
        ? directoryFromScopeHeader(request)
        : undefined;
      const clientId = request.headers.get("x-ohbaby-client-id") ?? undefined;
      requests.push({ clientId, directory, url: request.url });
      if (request.url.endsWith("/v1/scopes")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scopes: [
              {
                available: true,
                directory: "/repo-a",
                lastOpenedAt: 2,
                loaded: true,
                position: 0,
              },
              {
                available: true,
                directory: "/repo-b",
                lastOpenedAt: 1,
                loaded: false,
                position: 1,
              },
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
        {
          available: true,
          directory: "/repo-a",
          lastOpenedAt: 2,
          loaded: true,
          position: 0,
        },
        {
          available: true,
          directory: "/repo-b",
          lastOpenedAt: 1,
          loaded: false,
          position: 1,
        },
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
      const directory = directoryFromScopeHeader(request);
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
              {
                available: true,
                directory: "/repo-a",
                lastOpenedAt: 2,
                loaded: true,
                position: 0,
              },
              {
                available: true,
                directory: "/repo-b",
                lastOpenedAt: 1,
                loaded: false,
                position: 1,
              },
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

  it("browses directories without switching workspaces until a directory is opened", async () => {
    const requests: Request[] = [];
    const unicodeDirectory = "D:\\Upan\\books\\learning materials\\李笑来作品集";
    let workspaceOpened = false;
    const fetchImpl: typeof fetch = (input, init = {}) => {
      const request = new Request(input, init);
      requests.push(request);
      const directory = directoryFromScopeHeader(request);
      if (request.url.endsWith("/v1/scopes")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            scopes: workspaceOpened
              ? [
                  {
                    available: true,
                    directory: "/repo-a",
                    lastOpenedAt: 2,
                    loaded: true,
                    position: 0,
                  },
                  {
                    available: true,
                    directory: unicodeDirectory,
                    lastOpenedAt: 1,
                    loaded: false,
                    position: 1,
                  },
                ]
              : [
                  {
                    available: true,
                    directory: "/repo-a",
                    lastOpenedAt: 2,
                    loaded: true,
                    position: 0,
                  },
                ],
          }),
        );
      }
      if (request.url.endsWith("/v1/directory-picker/roots")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            roots: [{ directory: "/", name: "/" }],
          }),
        );
      }
      if (request.url.endsWith("/v1/directory-picker/list")) {
        return Promise.resolve(
          Response.json({
            children: [{ directory: "/repo-b", name: "repo-b" }],
            directory: "/",
            ok: true,
            parent: null,
          }),
        );
      }
      if (request.url.endsWith("/v1/scopes/open")) {
        workspaceOpened = true;
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
                  (): void => {
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
            snapshot: emptySnapshot(directory === unicodeDirectory ? "B" : "A"),
          }),
        );
      }
      if (request.url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
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

    const beforeBrowse = requests.length;
    await expect(runtime.getDirectoryPickerRoots()).resolves.toEqual({
      ok: true,
      roots: [{ directory: "/", name: "/" }],
    });
    await expect(runtime.listDirectoryPicker("/")).resolves.toEqual({
      children: [{ directory: "/repo-b", name: "repo-b" }],
      directory: "/",
      ok: true,
      parent: null,
    });
    expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/repo-a");
    expect(
      requests
        .slice(beforeBrowse)
        .map((request) => new URL(request.url).pathname),
    ).toEqual(["/v1/directory-picker/roots", "/v1/directory-picker/list"]);
    expect(
      requests
        .slice(beforeBrowse)
        .every((request) => !request.headers.has("x-ohbaby-directory")),
    ).toBe(true);

    const beforeSelection = requests.length;
    await runtime.openWorkspace(unicodeDirectory);

    const openRequest = requests.slice(beforeSelection)[0];
    expect(new URL(openRequest.url).pathname).toBe("/v1/scopes/open");
    expect(openRequest.headers.has("x-ohbaby-directory")).toBe(false);
    const scopedRequests = requests
      .slice(beforeSelection)
      .filter((request) => request.headers.has("x-ohbaby-directory"));
    expect(scopedRequests.length).toBeGreaterThan(0);
    for (const request of scopedRequests) {
      expect(request.headers.get("x-ohbaby-directory")).toBe(
        encodeURIComponent(unicodeDirectory),
      );
      expect(request.headers.get("x-ohbaby-directory-encoding")).toBe(
        "percent-utf8",
      );
    }
    expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe(
      unicodeDirectory,
    );
    expect(runtime.store.getSnapshot().view.snapshot?.sessions[0]?.title).toBe(
      "B",
    );
    await runtime.client.close();
  });
});
